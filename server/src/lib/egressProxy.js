import { randomBytes, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { log } from "./logger.js";
import { isPrivateAddress } from "./url.js";

/*
 * Network-level SSRF guard for yt-dlp and ffmpeg.
 *
 * Every outbound HTTP(S) connection made by the child processes goes through
 * this local forward proxy (they receive it via HTTP(S)_PROXY). For each
 * connection it:
 *   - requires a per-process secret (Proxy-Authorization),
 *   - only allows the configured ports (80/443 by default),
 *   - resolves DNS itself and refuses if ANY address is private/internal,
 *   - connects to the exact IP it checked (pinned), so DNS rebinding between
 *     the check and the connection is impossible.
 *
 * This covers redirects, embedded players, manifests and segment URLs that a
 * URL check on the initial link can't see.
 */

const HOP_HEADERS = ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "upgrade"];

async function defaultResolve(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return [bare];
  const addrs = await dns.lookup(bare, { all: true, verbatim: true });
  return addrs.map((a) => a.address);
}

export class EgressDenied extends Error {}

export async function startEgressProxy({
  allowedPorts = [80, 443],
  resolve = defaultResolve,
  isBlocked = isPrivateAddress,
  connectTimeoutMs = 15_000,
  idleTimeoutMs = 120_000,
  maxConnections = 512,
} = {}) {
  const user = "grabit";
  const secret = randomBytes(18).toString("base64url");
  const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`);
  const stats = { allowed: 0, denied: 0 };

  const authorised = (req) => {
    const got = Buffer.from(String(req.headers["proxy-authorization"] || ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  // Resolve and vet a destination; returns the pinned IP to connect to.
  async function vet(host, port) {
    if (!allowedPorts.includes(port)) throw new EgressDenied(`port ${port} not allowed`);
    let ips;
    try {
      ips = await resolve(host);
    } catch {
      throw new EgressDenied(`cannot resolve ${host}`);
    }
    if (ips.length === 0) throw new EgressDenied(`no address for ${host}`);
    const bad = ips.find((ip) => isBlocked(ip));
    if (bad) throw new EgressDenied(`${host} resolves to blocked address ${bad}`);
    return ips[0];
  }

  const deny = (host, reason) => {
    stats.denied += 1;
    log.warn("egress denied", { host, reason });
  };

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxying (absolute-form request line).
    if (!authorised(req)) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="egress"' }).end();
      return;
    }
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== "http:") throw new Error("bad scheme");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    let ip;
    try {
      ip = await vet(target.hostname, port);
    } catch (err) {
      deny(target.hostname, err.message);
      res.writeHead(403).end();
      return;
    }
    stats.allowed += 1;
    const headers = { ...req.headers };
    for (const h of HOP_HEADERS) delete headers[h];
    headers.host = target.host; // the target's, not whatever the client sent to the proxy
    const upstream = http.request(
      { host: ip, port, method: req.method, path: target.pathname + target.search, headers, timeout: connectTimeoutMs },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS (and anything else) via CONNECT tunnels; TLS stays end-to-end.
  // CONNECT sockets are detached from the HTTP server, so server.close() and
  // closeAllConnections() don't see them; track them to shut down cleanly.
  const tunnels = new Set();
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    tunnels.add(client);
    client.on("close", () => tunnels.delete(client));
    if (!authorised(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\n\r\n');
      return;
    }
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url || "");
    if (!m) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = m[1];
    const port = Number(m[2]);
    let ip;
    try {
      ip = await vet(host, port);
    } catch (err) {
      deny(host, err.message);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    stats.allowed += 1;
    const upstream = net.connect({ host: ip, port });
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error("connect timeout")));
    upstream.once("connect", () => {
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      client.setTimeout(idleTimeoutMs, () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.on("close", () => tunnels.delete(upstream));
    upstream.on("error", () => {
      if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    client.on("close", () => upstream.destroy());
  });

  server.maxConnections = maxConnections;
  server.on("clientError", (_err, socket) => socket.destroy());

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();

  return {
    url: `http://${user}:${secret}@127.0.0.1:${port}`,
    port,
    stats,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
        for (const s of tunnels) s.destroy();
      }),
  };
}
