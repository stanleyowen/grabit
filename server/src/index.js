import { createApp } from "./app.js";
import { config } from "./config.js";
import { log } from "./lib/logger.js";
import { YTDLP_BIN, ytdlpVersion } from "./lib/ytdlp.js";
import { limiters } from "./routes/api.js";
import { initJobs, shutdownJobs } from "./services/jobs.js";

await initJobs();

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  log.info("server listening", {
    host: config.host,
    port: config.port,
    ytdlp: YTDLP_BIN,
    ytdlpVersion: ytdlpVersion(),
    downloadConcurrency: config.jobs.concurrency,
    infoConcurrency: config.info.concurrency,
    trustProxy: config.trustProxy,
  });
});

// Slightly above typical proxy keepalive (nginx 60s) to avoid racy resets.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000; // time to receive the request; responses may stream longer

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info("shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  server.close();
  server.closeIdleConnections();
  Object.values(limiters).forEach((l) => l.close());
  await shutdownJobs().catch((e) => log.error("shutdown cleanup failed", { error: e.message }));
  clearTimeout(force);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason?.stack || reason) }));
process.on("uncaughtException", (error) => {
  log.error("uncaught exception", { error: error.stack });
  shutdown("uncaughtException");
});
