#!/usr/bin/env bash
# One-time server bootstrap for Ubuntu 22.04/24.04. Idempotent — safe to re-run.
# Run as root on the server:   sudo DOMAIN=yt-dl.example.com bash deploy/install.sh
# (deploy.sh --bootstrap does this for you over SSH.)
set -euo pipefail

APP_DIR=/opt/video-downloader
DATA_DIR=/var/lib/video-downloader
ENV_DIR=/etc/video-downloader
NODE_MAJOR=24
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg unzip ffmpeg rsync >/dev/null

echo "==> Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < 22 )); then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
node --version

echo "==> Deno (sandboxed JS runtime yt-dlp needs for YouTube)"
if ! command -v deno >/dev/null; then
  case "$(uname -m)" in
    x86_64) DENO_ASSET=deno-x86_64-unknown-linux-gnu.zip ;;
    aarch64) DENO_ASSET=deno-aarch64-unknown-linux-gnu.zip ;;
  esac
  TMP=$(mktemp -d)
  curl -fsSL --proto '=https' -o "$TMP/deno.zip" "https://github.com/denoland/deno/releases/latest/download/$DENO_ASSET"
  curl -fsSL --proto '=https' -o "$TMP/deno.zip.sha256sum" "https://github.com/denoland/deno/releases/latest/download/$DENO_ASSET.sha256sum"
  (cd "$TMP" && echo "$(awk '{print $1}' deno.zip.sha256sum)  deno.zip" | sha256sum -c --status) || { echo "deno checksum mismatch" >&2; exit 1; }
  unzip -o -q "$TMP/deno.zip" -d /usr/local/bin && chmod 0755 /usr/local/bin/deno
  rm -rf "$TMP"
fi
deno --version | head -1

echo "==> yt-dlp"
install -d -m 0755 "$APP_DIR/deploy"
install -m 0755 "$SRC_DIR/update-ytdlp.sh" "$APP_DIR/deploy/update-ytdlp.sh"
"$APP_DIR/deploy/update-ytdlp.sh"

echo "==> Service user and directories"
id ytdl >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin ytdl
install -d -m 0750 -o ytdl -g ytdl "$DATA_DIR" "$DATA_DIR/downloads"
install -d -m 0750 -o root -g ytdl "$ENV_DIR"
if [[ ! -f "$ENV_DIR/env" ]]; then
  install -m 0640 -o root -g ytdl "$SRC_DIR/../server/.env.example" "$ENV_DIR/env"
  sed -i 's#^X_ACCEL_PREFIX=.*#X_ACCEL_PREFIX=/_protected/#' "$ENV_DIR/env"
  echo "    created $ENV_DIR/env — review it"
fi

echo "==> systemd units"
install -m 0644 "$SRC_DIR/video-downloader.service" /etc/systemd/system/
install -m 0644 "$SRC_DIR/yt-dlp-update.service" "$SRC_DIR/yt-dlp-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now yt-dlp-update.timer
systemctl enable video-downloader.service

if command -v nginx >/dev/null && [[ -n "${DOMAIN:-}" ]]; then
  echo "==> nginx site for $DOMAIN"
  install -m 0644 "$SRC_DIR/nginx-proxy-snippet.conf" /etc/nginx/snippets/video-downloader-proxy.conf
  sed "s/__DOMAIN__/$DOMAIN/g" "$SRC_DIR/nginx.conf" > /etc/nginx/sites-available/video-downloader
  ln -sf /etc/nginx/sites-available/video-downloader /etc/nginx/sites-enabled/video-downloader
  usermod -aG ytdl www-data # nginx reads finished files for X-Accel-Redirect
  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    nginx -t && systemctl reload nginx
  else
    echo "    !! no certificate for $DOMAIN yet: run certbot, then 'nginx -t && systemctl reload nginx'"
  fi
else
  echo "==> nginx not configured (install nginx and pass DOMAIN=... to enable)"
fi

echo "==> Done. Deploy the app code with deploy/deploy.sh"
