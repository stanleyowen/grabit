// PM2 process definition (used by deploy/deploy-pm2.sh).
// Tunables live in ~/.config/video-downloader/env; values set here win over that file.
// VD_* variables exist only so the deploy script can smoke-test this exact
// config under a different name/port before swapping it in.
const os = require("node:os");
const path = require("node:path");

const HOME = os.homedir();
const BIN = path.join(HOME, ".local/opt/video-downloader/bin");
// Absolute interpreter: node may only be on PATH via nvm in interactive shells.
const NODE = process.execPath;

module.exports = {
  apps: [
    {
      name: process.env.VD_APP_NAME || "youtube-dl",
      cwd: __dirname,
      script: "src/index.js",
      interpreter: NODE,
      node_args: [`--env-file-if-exists=${path.join(HOME, ".config/video-downloader/env")}`, "--max-old-space-size=512"],
      // Job state is in memory: this MUST stay a single process (no cluster mode).
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      kill_timeout: 20000, // allow graceful shutdown to kill yt-dlp and clean up
      restart_delay: 3000,
      exp_backoff_restart_delay: 500,
      time: false, // the app already logs ISO timestamps
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1", // only cloudflared (localhost) can reach it — not the LAN
        PORT: process.env.VD_PORT || "3003",
        CLIENT_IP_HEADER: "cf-connecting-ip",
        TRUST_PROXY: "loopback",
        DOWNLOADS_DIR: process.env.VD_DOWNLOADS_DIR || path.join(HOME, ".local/share/video-downloader/downloads"),
        YTDLP_PATH: path.join(BIN, "yt-dlp"),
        XDG_CACHE_HOME: path.join(HOME, ".cache"),
        // yt-dlp finds deno + ffmpeg here; node's own dir kept for completeness.
        PATH: [BIN, path.dirname(NODE), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      },
    },
  ],
};
