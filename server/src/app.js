import net from "node:net";
import express from "express";
import { config } from "./config.js";
import { AppError } from "./lib/errors.js";
import { log } from "./lib/logger.js";
import { api } from "./routes/api.js";

function securityHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Permissions-Policy": "interest-cohort=()",
  });
  next();
}

// Strict allow-list CORS. With no CORS_ORIGINS configured, no cross-origin
// browser access is granted (same-origin / reverse-proxy only).
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin.toLowerCase())) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "Retry-After, Content-Disposition",
      "Access-Control-Max-Age": "600",
    });
    res.vary("Origin");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

const isLoopback = (addr = "") => addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");

// Resolve the real client IP once per request (used for rate limits and job caps).
function clientIp(req, _res, next) {
  req.clientIp = req.ip;
  if (config.clientIpHeader && isLoopback(req.socket.remoteAddress)) {
    const v = req.headers[config.clientIpHeader];
    if (typeof v === "string" && net.isIP(v.trim())) req.clientIp = v.trim();
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.set("etag", false);

  app.use(clientIp);
  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: "8kb", strict: true, type: "application/json" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", api);

  app.use((_req, _res, next) => next(new AppError(404, "not_found", "Not found.")));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let error = err;
    if (!(error instanceof AppError)) {
      if (err?.type === "entity.too.large") error = new AppError(413, "too_large", "Request body too large.");
      else if (err?.type === "entity.parse.failed") error = new AppError(400, "bad_json", "Malformed JSON.");
      else if (err?.code === "ENOENT") error = new AppError(404, "not_found", "File no longer exists.");
      else {
        log.error("unhandled error", { method: req.method, path: req.path, error: err?.message, stack: err?.stack });
        error = new AppError(500, "internal", "Something went wrong.");
      }
    }
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    if (res.headersSent) return res.end();
    // A failed file download may already have set attachment headers; without
    // this the browser saves the JSON error as a broken "video".
    res.removeHeader("Content-Disposition");
    res.type("application/json");
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  });

  return app;
}
