import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}=${raw} (expected integer ${min}..${max})`);
  }
  return value;
}

function list(name) {
  return (env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function bool(name, fallback) {
  const raw = (env[name] || "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid ${name}=${env[name]} (expected true/false)`);
}

function trustProxy(raw) {
  if (raw === undefined || raw === "") return "loopback";
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // e.g. "loopback, 10.0.0.0/8"
}

const MINUTE = 60_000;
const cpus = os.availableParallelism?.() ?? os.cpus().length;

export const config = Object.freeze({
  env: env.NODE_ENV || "development",
  host: env.HOST || "127.0.0.1",
  port: int("PORT", 3003, { min: 1, max: 65535 }),
  trustProxy: trustProxy(env.TRUST_PROXY),
  // e.g. "cf-connecting-ip" behind a Cloudflare Tunnel. Only honoured when the
  // TCP peer is loopback (i.e. the local tunnel daemon), so it can't be spoofed.
  clientIpHeader: (env.CLIENT_IP_HEADER || "").toLowerCase(),
  corsOrigins: list("CORS_ORIGINS"),
  // Resolver for SSRF checks + egress proxy. Empty = system resolver.
  dnsServers: list("DNS_SERVERS"),

  downloadsDir: path.resolve(env.DOWNLOADS_DIR || path.join(ROOT, "downloads")),
  // When set (e.g. "/_protected/"), nginx serves files via X-Accel-Redirect.
  xAccelPrefix: env.X_ACCEL_PREFIX || "",

  ytdlp: {
    bin: env.YTDLP_PATH || "",
    cookiesFile: env.YTDLP_COOKIES_FILE || "",
    jsRuntime: env.YTDLP_JS_RUNTIME || "",
    userAgent: env.YTDLP_USER_AGENT || "",
    // Hosts are matched by suffix. Empty = any public host.
    allowedHosts: list("ALLOWED_HOSTS"),
    // Direct media links and pages with embedded players. Only takes effect
    // while the egress proxy is enabled.
    generic: bool("ENABLE_GENERIC_EXTRACTOR", true),
    maxFileSize: env.MAX_FILESIZE || "4G",
    concurrentFragments: int("YTDLP_CONCURRENT_FRAGMENTS", 4, { min: 1, max: 16 }),
  },

  // Local forward proxy that blocks private/internal destinations for every
  // connection yt-dlp and ffmpeg make (see lib/egressProxy.js).
  egress: {
    enabled: bool("EGRESS_PROXY", true),
    allowedPorts: (env.EGRESS_ALLOWED_PORTS || "80,443")
      .split(",")
      .map((p) => Number.parseInt(p.trim(), 10))
      .filter((p) => p > 0 && p < 65536),
  },

  info: {
    concurrency: int("INFO_CONCURRENCY", Math.max(4, cpus * 2), { min: 1, max: 64 }),
    maxQueue: int("INFO_MAX_QUEUE", 200, { min: 0 }),
    timeoutMs: int("INFO_TIMEOUT_MS", 60_000, { min: 5_000 }),
    cacheTtlMs: int("INFO_CACHE_TTL_MS", 15 * MINUTE, { min: 0 }),
    cacheMaxEntries: int("INFO_CACHE_MAX", 1000, { min: 0 }),
    playlistLimit: int("PLAYLIST_LIMIT", 200, { min: 1, max: 5000 }),
  },

  jobs: {
    concurrency: int("MAX_CONCURRENT_DOWNLOADS", Math.max(2, Math.min(cpus, 8)), { min: 1, max: 64 }),
    maxQueue: int("MAX_DOWNLOAD_QUEUE_SIZE", 500, { min: 0 }),
    maxActivePerClient: int("MAX_ACTIVE_JOBS_PER_CLIENT", 6, { min: 1 }),
    retryLimit: int("DOWNLOAD_RETRY_LIMIT", 1, { min: 0, max: 5 }),
    timeoutMs: int("DOWNLOAD_TIMEOUT_MS", 45 * MINUTE, { min: MINUTE }),
    fileTtlMs: int("FILE_TTL_MS", 20 * MINUTE, { min: MINUTE }),
    abandonAfterMs: int("ABANDON_AFTER_MS", 5 * MINUTE, { min: MINUTE }),
    minFreeDiskBytes: int("MIN_FREE_DISK_MB", 2048, { min: 0 }) * 1024 * 1024,
  },

  rateLimits: {
    info: { capacity: int("RL_INFO_PER_MIN", 30, { min: 1 }), windowMs: MINUTE },
    create: { capacity: int("RL_JOBS_PER_MIN", 60, { min: 1 }), windowMs: MINUTE },
    status: { capacity: int("RL_STATUS_PER_MIN", 600, { min: 1 }), windowMs: MINUTE },
    file: { capacity: int("RL_FILES_PER_MIN", 60, { min: 1 }), windowMs: MINUTE },
  },
});
