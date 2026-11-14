import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { log } from "./logger.js";

const STDERR_TAIL = 64 * 1024;
const KILL_GRACE_MS = 5_000;

function resolveBinary() {
  const candidates = [config.ytdlp.bin, "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", path.join(os.homedir(), ".local/bin/yt-dlp")];
  for (const p of candidates.filter(Boolean)) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  try {
    return execFileSync("which", ["yt-dlp"], { encoding: "utf8" }).trim() || "yt-dlp";
  } catch {
    return "yt-dlp";
  }
}

export const YTDLP_BIN = resolveBinary();

export function ytdlpVersion() {
  try {
    return execFileSync(YTDLP_BIN, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

// URL of the local egress proxy (lib/egressProxy.js), set at startup.
let egressProxyUrl = null;
export function setEgressProxy(url) {
  egressProxyUrl = url;
}
export const genericEnabled = () => config.ytdlp.generic && Boolean(egressProxyUrl);

// Only pass through what yt-dlp needs; never leak the server's secrets to the child.
function childEnv() {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CACHE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env = { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  if (egressProxyUrl) {
    // Every HTTP(S) request from yt-dlp and ffmpeg goes through the egress
    // proxy. Passed via env (not argv) so the secret isn't visible in `ps`.
    // NO_PROXY is deliberately not passed: nothing may bypass the proxy.
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[k] = egressProxyUrl;
  } else {
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

function baseArgs() {
  const args = [
    "--ignore-config", // never let a stray config file add options like --exec
    "--no-color",
    "--no-warnings",
    // The generic extractor (direct media links, pages with embedded players)
    // fetches arbitrary URLs, so it is only enabled while the egress proxy is
    // enforcing the private-address block at the network level.
    "--use-extractors", genericEnabled() ? "default" : "default,-generic",
    "--socket-timeout", "20",
    "--retries", "3",
    "--fragment-retries", "3",
  ];
  if (config.ytdlp.jsRuntime) args.push("--js-runtimes", config.ytdlp.jsRuntime);
  if (config.ytdlp.userAgent) args.push("--user-agent", config.ytdlp.userAgent);
  return args;
}

/**
 * yt-dlp rewrites the cookie jar on exit; concurrent processes sharing one
 * file corrupt it. Give each process its own private copy.
 */
async function prepareCookies() {
  if (!config.ytdlp.cookiesFile) return { args: [], cleanup: async () => {} };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ytc-"));
  const file = path.join(dir, "cookies.txt");
  await fsp.copyFile(config.ytdlp.cookiesFile, file);
  await fsp.chmod(file, 0o600);
  return { args: ["--cookies", file], cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

/**
 * Spawn yt-dlp with a hard timeout and process-group kill (ffmpeg children
 * die with it). Resolves with captured stdout (if captureStdout) or "".
 *
 * opts.onLine(line)  - called for each stdout line when not capturing
 * opts.maxStdout     - kill & fail if stdout exceeds this many bytes
 * opts.signal        - AbortSignal to cancel
 */
export async function runYtDlp(args, { timeoutMs, captureStdout = false, maxStdout = 32 * 1024 * 1024, onLine, signal } = {}) {
  const cookies = await prepareCookies();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(YTDLP_BIN, [...baseArgs(), ...cookies.args, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group so we can kill ffmpeg too
        env: childEnv(),
      });

      const chunks = [];
      let stdoutBytes = 0;
      let lineBuf = "";
      let stderr = "";
      let settled = false;
      let killReason = null;
      let killTimer = null;

      const killGroup = (reason) => {
        if (killReason || child.exitCode !== null) return;
        killReason = reason;
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, KILL_GRACE_MS);
        killTimer.unref();
      };

      const timer = setTimeout(() => killGroup("timeout"), timeoutMs);
      const onAbort = () => killGroup("aborted");
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (captureStdout) {
          if (stdoutBytes > maxStdout) return killGroup("output_limit");
          chunks.push(chunk);
          return;
        }
        if (!onLine) return;
        lineBuf += chunk.toString("utf8");
        let idx;
        while ((idx = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, idx).trimEnd();
          lineBuf = lineBuf.slice(idx + 1);
          if (line) onLine(line);
        }
        if (lineBuf.length > 64 * 1024) lineBuf = ""; // guard pathological lines
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL);
      });

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve(value);
      };

      child.on("error", (err) => finish(err));
      child.on("close", (code, sig) => {
        if (killTimer) clearTimeout(killTimer);
        if (lineBuf && onLine) onLine(lineBuf.trimEnd());
        if (code === 0 && !killReason) {
          return finish(null, captureStdout ? Buffer.concat(chunks).toString("utf8") : "");
        }
        const err = new Error(killReason ? `yt-dlp ${killReason}` : `yt-dlp exited with code ${code}${sig ? ` (${sig})` : ""}`);
        err.stderr = stderr;
        err.timedOut = killReason === "timeout";
        err.aborted = killReason === "aborted";
        if (!err.aborted) log.warn("yt-dlp failed", { code, signal: sig, reason: killReason, stderr: stderr.slice(-2000) });
        finish(err);
      });
    });
  } finally {
    await cookies.cleanup().catch(() => {});
  }
}
