import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fixtures", "fake-ytdlp.mjs");
fs.chmodSync(fake, 0o755);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-test-"));

Object.assign(process.env, {
  YTDLP_PATH: fake,
  DOWNLOADS_DIR: tmp,
  MAX_CONCURRENT_DOWNLOADS: "1",
  MAX_ACTIVE_JOBS_PER_CLIENT: "3",
  MIN_FREE_DISK_MB: "0",
  CORS_ORIGINS: "https://app.example.com",
  CLIENT_IP_HEADER: "cf-connecting-ip",
});

const { createApp } = await import("../src/app.js");
const { initJobs, shutdownJobs } = await import("../src/services/jobs.js");
const { limiters } = await import("../src/routes/api.js");

let server;
let base;
before(async () => {
  await initJobs();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  Object.values(limiters).forEach((l) => l.close());
  await shutdownJobs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const VIDEO = "https://youtu.be/jNQXAC9IVRw";

async function waitFor(id, status) {
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (s.status === status) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${status}`);
}

test("info returns trimmed metadata with h264-preferred formats", async () => {
  const res = await post("/api/info", { url: VIDEO });
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.type, "video");
  assert.equal(info.url, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  assert.deepEqual(info.formats.map((f) => f.id), ["360p", "240p", "m4a", "mp3"]);
  assert.equal(info.formats[0].size, 1_300_000, "h264 360p + m4a audio");
  assert.equal(info.thumbnail, "https://i.ytimg.com/b.jpg");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("playlist info marks unavailable entries", async () => {
  const info = await (await post("/api/info", { url: "https://www.youtube.com/playlist?list=PLplaylist" })).json();
  assert.equal(info.type, "playlist");
  assert.deepEqual(info.entries.map((e) => e.available), [true, false]);
});

test("errors are sanitised", async () => {
  const res = await post("/api/info", { url: "https://www.youtube.com/watch?v=unavailable" });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "unavailable");
  assert.doesNotMatch(JSON.stringify(body), /secret|ERROR/);
});

test("rejects bad input", async () => {
  assert.equal((await post("/api/info", { url: "http://127.0.0.1:22" })).status, 400);
  assert.equal((await post("/api/jobs", { url: VIDEO, quality: "--exec" })).status, 400);
  const big = await fetch(base + "/api/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "x".repeat(20_000) }) });
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${base}/api/jobs/../../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/not-a-uuid/file`)).status, 404);
});

test("job lifecycle: queue -> ready -> file, de-duplicated across clients", async () => {
  const a = await (await post("/api/jobs", { url: VIDEO, quality: "360p" })).json();
  const b = await (await post("/api/jobs", { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5", quality: "360p" })).json();
  assert.notEqual(a.id, b.id, "each client gets its own ticket");

  const ready = await waitFor(a.id, "ready");
  assert.equal(ready.fileName, "Me at the zoo.mp4");
  assert.equal(ready.progress, 100);
  assert.equal((await waitFor(b.id, "ready")).fileName, "Me at the zoo.mp4");

  const batch = await (await fetch(`${base}/api/jobs?ids=${a.id},${b.id},bogus`)).json();
  assert.deepEqual(Object.keys(batch.jobs), [a.id, b.id]);

  const file = await fetch(`${base}/api/jobs/${a.id}/file`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /attachment; filename="Me at the zoo.mp4"/);
  assert.equal((await file.arrayBuffer()).byteLength, 1000);

  // Only one task directory exists on disk for both tickets.
  assert.equal(fs.readdirSync(tmp).length, 1);
});

test("cancel kills a queued/running job", async () => {
  const j = await (await post("/api/jobs", { url: "https://www.youtube.com/watch?v=slowslowslo", quality: "mp3" })).json();
  const del = await fetch(`${base}/api/jobs/${j.id}`, { method: "DELETE" });
  assert.equal(del.status, 204);
  assert.equal((await fetch(`${base}/api/jobs/${j.id}`)).status, 404);
});

test("per-client active job cap", async () => {
  const ids = ["slowAAAAAAA", "slowBBBBBBB", "slowCCCCCCC", "slowDDDDDDD"];
  const results = [];
  for (const id of ids) results.push(await post("/api/jobs", { url: `https://www.youtube.com/watch?v=${id}`, quality: "720p" }));
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 429]);
  assert.ok(results[3].headers.get("retry-after"));

  // A different real client behind the tunnel (CF-Connecting-IP from loopback) has its own cap.
  const other = await fetch(base + "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=slowEEEEEEE", quality: "720p" }),
  });
  assert.equal(other.status, 201);
  // Garbage in the header is ignored (falls back to the socket IP, which is capped).
  const spoof = await fetch(base + "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "not-an-ip" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=slowFFFFFFF", quality: "720p" }),
  });
  assert.equal(spoof.status, 429);

  for (const r of [...results.slice(0, 3), other]) await fetch(`${base}/api/jobs/${(await r.json()).id}`, { method: "DELETE" });
});

test("CORS only for allow-listed origins", async () => {
  const ok = await fetch(base + "/api/health", { headers: { Origin: "https://app.example.com" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
  const bad = await fetch(base + "/api/health", { headers: { Origin: "https://evil.example" } });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});
