#!/usr/bin/env bash
# Deploy the backend to a server that runs apps under PM2 as a normal user
# (no sudo needed), e.g. behind a Cloudflare Tunnel.
#
#   deploy/deploy-pm2.sh user@host
#
# What it does on the server:
#   1. installs/updates yt-dlp + deno into ~/.local/opt/video-downloader/bin (checksum-verified)
#   2. installs the release next to the live app and smoke-tests it on a spare port
#   3. swaps it in, restarts the PM2 app, health-checks, and rolls back automatically on failure
#   4. ensures a daily yt-dlp update cron entry
set -euo pipefail

HOST="${1:?usage: deploy-pm2.sh user@host}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Running tests locally"
(cd "$ROOT/server" && npm test >/dev/null) || { echo "tests failed — aborting deploy" >&2; exit 1; }

echo "==> Uploading release to $HOST"
ssh "$HOST" 'rm -rf ~/server/.youtube-downloader-release && mkdir -p ~/server/.youtube-downloader-release/deploy'
rsync -az --delete \
  --exclude node_modules --exclude downloads --exclude test --exclude '.env' --exclude '.DS_Store' \
  "$ROOT/server/" "$HOST:server/.youtube-downloader-release/"
rsync -az "$ROOT/deploy/update-ytdlp.sh" "$HOST:server/.youtube-downloader-release/deploy/"

echo "==> Installing on $HOST"
ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null

APP="$HOME/server/youtube-downloader"
REL="$HOME/server/.youtube-downloader-release"
BIN="$HOME/.local/opt/video-downloader/bin"
DATA="$HOME/.local/share/video-downloader"
CONF="$HOME/.config/video-downloader"
NAME=youtube-dl

node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "need Node >= 22" >&2; exit 1; }
mkdir -p "$BIN" "$DATA/downloads" "$CONF"
chmod 700 "$DATA" "$CONF"

if [[ ! -f "$CONF/env" ]]; then
  cat > "$CONF/env" <<'ENV'
# Tunables for the video downloader (see .env.example in the app for all options).
# Shared home server: keep concurrency modest so other services stay responsive.
MAX_CONCURRENT_DOWNLOADS=3
INFO_CONCURRENCY=6
MIN_FREE_DISK_MB=5120
MAX_FILESIZE=3G
# Origins allowed to call the API directly from the browser, comma-separated.
CORS_ORIGINS=
ENV
  chmod 600 "$CONF/env"
  echo "    created $CONF/env"
fi

echo "--> yt-dlp"
YTDLP_DEST="$BIN/yt-dlp" bash "$REL/deploy/update-ytdlp.sh"

echo "--> deno"
if [[ ! -x "$BIN/deno" ]]; then
  T=$(mktemp -d)
  A=deno-x86_64-unknown-linux-gnu.zip; [[ "$(uname -m)" == aarch64 ]] && A=deno-aarch64-unknown-linux-gnu.zip
  curl -fsSL --proto '=https' -o "$T/deno.zip" "https://github.com/denoland/deno/releases/latest/download/$A"
  curl -fsSL --proto '=https' -o "$T/sum" "https://github.com/denoland/deno/releases/latest/download/$A.sha256sum"
  (cd "$T" && echo "$(awk '{print $1}' sum)  deno.zip" | sha256sum -c --status) || { echo "deno checksum mismatch" >&2; exit 1; }
  python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract("deno", sys.argv[2])' "$T/deno.zip" "$BIN"
  chmod 0755 "$BIN/deno"; rm -rf "$T"
fi
"$BIN/deno" --version | head -1

echo "--> dependencies"
cd "$REL"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

echo "--> smoke test: exact PM2 config on :3013"
SMOKE=$(mktemp -d)
export VD_APP_NAME="$NAME-smoke" VD_PORT=3013 VD_DOWNLOADS_DIR="$SMOKE"
pm2 delete "$VD_APP_NAME" >/dev/null 2>&1 || true
pm2 start "$REL/ecosystem.config.cjs" >/dev/null
ok=0
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3013/health >/dev/null 2>&1 && { ok=1; break; }; sleep 0.5; done
# Real yt-dlp + deno + JS challenge check, fully offline-safe if YouTube is unreachable.
if [[ $ok == 1 ]]; then
  INFO=$(curl -s -m 60 -XPOST http://127.0.0.1:3013/api/info -H 'Content-Type: application/json' -d '{"url":"https://youtu.be/jNQXAC9IVRw"}')
  echo "$INFO" | grep -q '"type":"video"' && echo "    yt-dlp info OK" || echo "    !! yt-dlp info check failed: ${INFO:0:300}" >&2
else
  echo "smoke test failed:" >&2
  pm2 logs "$VD_APP_NAME" --lines 30 --nostream >&2 || true
  tail -5 "$HOME/.pm2/pm2.log" >&2 || true
fi
pm2 delete "$VD_APP_NAME" >/dev/null 2>&1 || true
unset VD_APP_NAME VD_PORT VD_DOWNLOADS_DIR
rm -rf "$SMOKE"
[[ $ok == 1 ]] || exit 1

echo "--> swap and restart"
cd "$HOME" # never sit inside a directory we're about to move or delete
PREV="$HOME/server/.youtube-downloader-prev-$(date +%Y%m%d%H%M%S)"
[[ -d "$APP" ]] && mv "$APP" "$PREV"
mv "$REL" "$APP"
pm2 delete "$NAME" >/dev/null 2>&1 || true
pm2 start "$APP/ecosystem.config.cjs" >/dev/null

healthy=0
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:3003/health >/dev/null 2>&1 && { healthy=1; break; }; sleep 0.5; done
if [[ $healthy != 1 ]]; then
  echo "!! new release unhealthy — rolling back" >&2
  pm2 logs "$NAME" --lines 30 --nostream >&2 || true
  pm2 delete "$NAME" >/dev/null 2>&1 || true
  rm -rf "$APP"; mv "$PREV" "$APP"
  if [[ -f "$APP/ecosystem.config.cjs" ]]; then pm2 start "$APP/ecosystem.config.cjs"; else (cd "$APP" && pm2 start server.js --name "$NAME"); fi
  cd "$HOME"
  pm2 save >/dev/null
  exit 1
fi
pm2 save >/dev/null
echo "    healthy: $(curl -fsS http://127.0.0.1:3003/api/health)"

# Old releases: drop their temp downloads, keep the 2 newest for rollback.
for d in "$HOME"/server/.youtube-downloader-prev-*; do [[ -d "$d/downloads" ]] && rm -rf "$d/downloads"; done
ls -dt "$HOME"/server/.youtube-downloader-prev-* 2>/dev/null | tail -n +3 | xargs -r rm -rf

echo "--> daily yt-dlp update (cron)"
LINE="17 4 * * * YTDLP_DEST=$BIN/yt-dlp bash $APP/deploy/update-ytdlp.sh >> $DATA/ytdlp-update.log 2>&1"
{ { crontab -l 2>/dev/null || true; } | { grep -v 'update-ytdlp.sh' || true; }; echo "$LINE"; } | crontab -
crontab -l | grep -q 'update-ytdlp.sh' || { echo "failed to install cron entry" >&2; exit 1; }
REMOTE

echo "==> Deployed. Logs: ssh $HOST 'pm2 logs youtube-dl'"
