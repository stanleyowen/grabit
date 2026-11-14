// PM2 process definition.
//
// Settings are merged in this order (later wins):
//   1. defaults below (safe for a single box behind a Cloudflare Tunnel)
//   2. ~/.config/video-downloader/env   (used by deploy/deploy-pm2.sh)
//   3. server/.env                       (used when running from a git clone)
//
// After editing a .env file, apply it with:
//   pm2 restart ecosystem.config.cjs --update-env
//
// VD_* variables exist only so deploy-pm2.sh can smoke-test this exact
// config under a different name/port before swapping it in.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseEnv } = require("node:util");

const HOME = os.homedir();
const BIN = path.join(HOME, ".local/opt/video-downloader/bin");
// Absolute interpreter: node may only be on PATH via nvm in interactive shells.
const NODE = process.execPath;

function readEnv(file) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const env = {
  NODE_ENV: "production",
  HOST: "127.0.0.1", // only cloudflared (localhost) can reach it — not the LAN
  PORT: "3003",
  CLIENT_IP_HEADER: "cf-connecting-ip",
  TRUST_PROXY: "loopback",
  DOWNLOADS_DIR: path.join(HOME, ".local/share/video-downloader/downloads"),
  YTDLP_PATH: path.join(BIN, "yt-dlp"),
  XDG_CACHE_HOME: path.join(HOME, ".cache"),
  ...readEnv(path.join(HOME, ".config/video-downloader/env")),
  ...readEnv(path.join(__dirname, ".env")),
  // yt-dlp finds deno + ffmpeg here; node's own dir kept for completeness.
  PATH: [BIN, path.dirname(NODE), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
};
if (process.env.VD_PORT) env.PORT = process.env.VD_PORT;
if (process.env.VD_DOWNLOADS_DIR) env.DOWNLOADS_DIR = process.env.VD_DOWNLOADS_DIR;

module.exports = {
  apps: [
    {
      name: process.env.VD_APP_NAME || "grabit",
      cwd: __dirname,
      script: "src/index.js",
      interpreter: NODE,
      node_args: ["--max-old-space-size=512"],
      // Job state is in memory: this MUST stay a single process (no cluster mode).
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 20000, // allow graceful shutdown to kill yt-dlp and clean up
      restart_delay: 3000,
      exp_backoff_restart_delay: 500,
      time: false, // the app already logs ISO timestamps
      env,
    },
  ],
};
