import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { startEgressProxy } from "../src/lib/egressProxy.js";

function authHeader(proxyUrl) {
  const u = new URL(proxyUrl);
  return `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
}

// Issue a CONNECT and resolve with the proxy's status code (and socket on 200).
function connect(proxy, target, auth = authHeader(proxy.url)) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "CONNECT",
      path: target,
      headers: auth ? { "proxy-authorization": auth } : {},
    });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode, reason: res.statusMessage, socket }));
    req.on("response", (res) => resolve({ status: res.statusCode }));
    req.on("error", reject);
    req.end();
  });
}

// Plain-HTTP proxy request (absolute-form URL).
function proxyGet(proxy, url, auth = authHeader(proxy.url)) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "GET",
      path: url,
      headers: auth ? { "proxy-authorization": auth } : {},
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let strict; // default policy: private addresses blocked
before(async () => {
  strict = await startEgressProxy();
});
after(async () => {
  await strict.close();
});

test("blocks private, loopback and metadata destinations (CONNECT)", async () => {
  for (const target of ["127.0.0.1:443", "localhost:443", "10.0.0.1:443", "169.254.169.254:80", "[::1]:443", "192.168.1.100:443"]) {
    const { status } = await connect(strict, target);
    assert.equal(status, 403, target);
  }
});

test("blocks private destinations for plain HTTP too", async () => {
  for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://localhost:80/"]) {
    assert.equal((await proxyGet(strict, url)).status, 403, url);
  }
});

test("blocks a hostname if ANY of its addresses is private (DNS-based SSRF)", async () => {
  const p = await startEgressProxy({ resolve: async () => ["93.184.216.34", "127.0.0.1"] });
  assert.equal((await connect(p, "evil.example:443")).status, 403);
  await p.close();
});

test("reports DNS-filter sinkholes distinctly", async () => {
  const p = await startEgressProxy({ resolve: async () => ["0.0.0.0", "::"] });
  const r = await connect(p, "blocked-by-adguard.example:443");
  assert.equal(r.status, 403);
  assert.match(r.reason, /DNS Filter/);
  const priv = await connect(strict, "127.0.0.1:443");
  assert.match(priv.reason, /Private Address/);
  await p.close();
});

test("only allows configured ports", async () => {
  const p = await startEgressProxy({ resolve: async () => ["93.184.216.34"] });
  for (const port of [22, 25, 3003, 6379, 8080]) {
    assert.equal((await connect(p, `example.com:${port}`)).status, 403, String(port));
  }
  await p.close();
});

test("requires the per-process secret", async () => {
  assert.equal((await connect(strict, "example.com:443", null)).status, 407);
  assert.equal((await connect(strict, "example.com:443", "Basic Z3JhYml0Ondyb25n")).status, 407);
  assert.equal((await proxyGet(strict, "http://example.com/", null)).status, 407);
});

test("tunnels and forwards to allowed destinations, pinned to the vetted IP", async () => {
  // Local upstream server standing in for a public host.
  let seenHeaders = null;
  const upstream = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end(`hello from ${req.headers.host}${req.url}`);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;
  const resolved = [];
  const p = await startEgressProxy({
    allowedPorts: [port],
    isBlocked: () => false,
    resolve: async (host) => {
      resolved.push(host);
      return ["127.0.0.1"];
    },
  });
  try {

    // Plain HTTP: forwarded with the original Host header, proxy secret stripped.
    const r = await proxyGet(p, `http://media.example:${port}/a.mp4?x=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body, `hello from media.example:${port}/a.mp4?x=1`);
    assert.equal(seenHeaders["proxy-authorization"], undefined);

    // CONNECT tunnel carries raw bytes end to end.
    const { status, socket } = await connect(p, `media.example:${port}`);
    assert.equal(status, 200);
    const body = await new Promise((resolve) => {
      let data = "";
      socket.on("data", (c) => (data += c));
      socket.on("end", () => resolve(data));
      socket.write(`GET /tunnel HTTP/1.1\r\nHost: media.example\r\nConnection: close\r\n\r\n`);
    });
    assert.match(body, /hello from media\.example\/tunnel/);
    assert.deepEqual(resolved, ["media.example", "media.example"]);
  } finally {
    await p.close();
    upstream.close();
  }
});

test("closes cleanly with open tunnels", async () => {
  const sink = net.createServer((s) => s.on("data", () => {}));
  await new Promise((r) => sink.listen(0, "127.0.0.1", r));
  const port = sink.address().port;
  const p = await startEgressProxy({ allowedPorts: [port], isBlocked: () => false, resolve: async () => ["127.0.0.1"] });
  const { status, socket } = await connect(p, `x.example:${port}`);
  assert.equal(status, 200);
  await p.close();
  await new Promise((r) => (socket.destroyed ? r() : socket.on("close", r)));
  sink.close();
});
