// Manual security probe (not part of `npm test`): runs the REAL yt-dlp through
// the egress proxy against internal targets and checks a loopback canary.
//   node test/fixtures/ssrf-probe.mjs [path-to-yt-dlp]
import { execFile } from "node:child_process";
import http from "node:http";
import { startEgressProxy } from "../../src/lib/egressProxy.js";

const bin = process.argv[2] || "yt-dlp";
let hits = 0;
const canary = http.createServer((_q, r) => { hits++; r.end("SECRET"); });
await new Promise((r) => canary.listen(80 < 1024 && process.getuid?.() === 0 ? 80 : 8099, "127.0.0.1", r));
const cport = canary.address().port;
const proxy = await startEgressProxy({ allowedPorts: [80, 443, cport] }); // even with the canary's port allowed

const targets = [
  `http://127.0.0.1:${cport}/canary`,
  `http://localhost:${cport}/canary`,
  `http://127.0.0.1.nip.io:${cport}/canary`, // public DNS name resolving to loopback
  `http://[::1]:${cport}/canary`,
  `http://169.254.169.254/latest/meta-data/`,
  `http://192.168.1.1/`,
  `https://10.0.0.1/`,
];
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[k] = proxy.url;
for (const url of targets) {
  // Async on purpose: the proxy lives in this process and must keep serving.
  const r = await new Promise((resolve) =>
    execFile(bin, ["--ignore-config", "--no-warnings", "--use-extractors", "default", "--socket-timeout", "5", "-J", "--", url], { env, timeout: 60000 }, (error, _out, stderr) =>
      resolve({ ok: !error, stderr: String(stderr) })));
  const err = (r.stderr.split("\n").find((l) => l.startsWith("ERROR")) || "").slice(0, 110);
  console.log(`${r.ok ? "!! FETCHED" : "blocked  "}  ${url.padEnd(48)} ${err}`);
}
console.log(`\nproxy: ${proxy.stats.allowed} allowed, ${proxy.stats.denied} denied | canary hits: ${hits}`);
await proxy.close(); canary.close();
process.exit(hits === 0 ? 0 : 1);
