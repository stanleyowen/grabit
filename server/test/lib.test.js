import assert from "node:assert/strict";
import { test } from "node:test";
import { fromYtDlpError } from "../src/lib/errors.js";
import { RateLimiter } from "../src/lib/rateLimit.js";
import { Semaphore } from "../src/lib/semaphore.js";
import { TtlCache } from "../src/lib/ttlCache.js";
import { isPrivateAddress, normalizeUrl } from "../src/lib/url.js";

test("normalizeUrl canonicalises YouTube links", () => {
  const id = "jNQXAC9IVRw";
  for (const u of [
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/watch?v=${id}&t=10s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`,
    `youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&feature=share`,
  ]) {
    assert.equal(normalizeUrl(u).url, `https://www.youtube.com/watch?v=${id}`, u);
  }
  const withList = normalizeUrl(`https://www.youtube.com/watch?v=${id}&list=PL12345`);
  assert.equal(withList.kind, "video");
  assert.equal(withList.playlistUrl, "https://www.youtube.com/playlist?list=PL12345");
  assert.equal(normalizeUrl("https://www.youtube.com/playlist?list=PL12345").kind, "playlist");
});

test("normalizeUrl rejects unsafe input", () => {
  for (const bad of [
    "", "   ", 42, null, "-x", "--exec=rm -rf /", "file:///etc/passwd", "ftp://example.com/a",
    "javascript:alert(1)", "http://localhost/a", "http://127.0.0.1/a", "http://10.0.0.5/a",
    "http://[::1]/a", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1:8080/",
    "https://user:pass@example.com/", "http://intranet/", "http://printer.local/",
    "https://example.com:22/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f000001/",
    `https://example.com/${"a".repeat(3000)}`, "youtube:abc", "https://www.youtube.com/watch?v=bad",
  ]) {
    assert.throws(() => normalizeUrl(bad), { status: 400 }, String(bad));
  }
});

test("normalizeUrl enforces the host allow-list", () => {
  assert.throws(() => normalizeUrl("https://vimeo.com/123", { allowedHosts: ["youtube.com"] }), { code: "unsupported" });
  assert.equal(normalizeUrl("https://player.vimeo.com/1", { allowedHosts: ["vimeo.com"] }).kind, "unknown");
  assert.equal(normalizeUrl("https://youtu.be/jNQXAC9IVRw", { allowedHosts: ["youtube.com"] }).kind, "video");
});

test("isPrivateAddress", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "100.64.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "142.250.72.14", "2607:f8b0:4005::200e"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("errors never leak stderr", () => {
  const err = Object.assign(new Error("exit 1"), { stderr: "ERROR: Video unavailable /home/secret" });
  const mapped = fromYtDlpError(err);
  assert.equal(mapped.code, "unavailable");
  assert.doesNotMatch(mapped.message, /secret/);
  assert.equal(fromYtDlpError(Object.assign(new Error("x"), { stderr: "weird /etc/x" })).message, "Couldn't process this link.");
});

test("TtlCache evicts LRU and expires", async () => {
  const c = new TtlCache({ max: 2, ttlMs: 30 });
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get("a"), undefined);
});

test("RateLimiter allows bursts up to capacity", () => {
  const rl = new RateLimiter({ capacity: 3, windowMs: 60_000 });
  assert.ok(rl.take("x").ok && rl.take("x").ok && rl.take("x").ok);
  const denied = rl.take("x");
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfter > 0);
  assert.ok(rl.take("y").ok, "separate clients have separate buckets");
  rl.close();
});

test("Semaphore bounds concurrency and queue", async () => {
  const s = new Semaphore(2, 1);
  let active = 0;
  let peak = 0;
  const job = () => s.run(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
  });
  const runs = [job(), job(), job()];
  await assert.rejects(job(), { code: "busy" });
  await Promise.all(runs);
  assert.equal(peak, 2);
});
