#!/usr/bin/env bash
# Deploy the backend to an Ubuntu server over SSH.
#
#   deploy/deploy.sh user@host                 # ship code + restart
#   deploy/deploy.sh user@host --bootstrap     # first time: also run install.sh
#   DOMAIN=yt-dl.example.com deploy/deploy.sh user@host --bootstrap
#
# Requires: ssh access with sudo on the server, rsync locally and remotely.
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [--bootstrap]}"
BOOTSTRAP="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="/tmp/video-downloader-release"

echo "==> Running tests locally"
(cd "$ROOT/server" && npm test >/dev/null) || { echo "tests failed — aborting deploy" >&2; exit 1; }

echo "==> Uploading to $HOST"
ssh "$HOST" "rm -rf $STAGE && mkdir -p $STAGE"
rsync -az --delete \
  --exclude node_modules --exclude downloads --exclude test --exclude '.env*' --exclude '.DS_Store' \
  "$ROOT/server" "$ROOT/deploy" "$HOST:$STAGE/"
scp -q "$ROOT/server/.env.example" "$HOST:$STAGE/server/.env.example"

if [[ "$BOOTSTRAP" == "--bootstrap" ]]; then
  echo "==> Bootstrapping server"
  ssh -t "$HOST" "sudo DOMAIN='${DOMAIN:-}' bash $STAGE/deploy/install.sh"
fi

echo "==> Installing release"
ssh -t "$HOST" "sudo bash -s" <<EOF
set -euo pipefail
APP=/opt/video-downloader
install -d -m 0755 "\$APP"
# Code is owned by root and read-only to the service user: a compromised
# process can't rewrite its own code.
rsync -a --delete --exclude node_modules $STAGE/server/ "\$APP/server/"
rsync -a --delete $STAGE/deploy/ "\$APP/deploy/"
chown -R root:root "\$APP"
chmod -R a+rX,go-w "\$APP"
cd "\$APP/server"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
systemctl restart video-downloader
for i in \$(seq 1 20); do
  if curl -fsS http://127.0.0.1:3003/health >/dev/null 2>&1; then echo "healthy"; break; fi
  sleep 0.5
  [[ \$i == 20 ]] && { journalctl -u video-downloader -n 40 --no-pager; exit 1; }
done
rm -rf $STAGE
EOF

echo "==> Deployed. Logs: ssh $HOST 'journalctl -u video-downloader -f'"
