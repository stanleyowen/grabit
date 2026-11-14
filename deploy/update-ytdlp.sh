#!/usr/bin/env bash
# Install/refresh the standalone yt-dlp binary, verifying its SHA-256 against
# the release's published checksums before replacing the current one.
#   sudo deploy/update-ytdlp.sh                         -> /usr/local/bin/yt-dlp
#   YTDLP_DEST=~/.local/opt/video-downloader/bin/yt-dlp deploy/update-ytdlp.sh   (no root)
set -euo pipefail

DEST="${YTDLP_DEST:-/usr/local/bin/yt-dlp}"
case "$(uname -m)" in
  x86_64) ASSET=yt-dlp_linux ;;
  aarch64 | arm64) ASSET=yt-dlp_linux_aarch64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
BASE=https://github.com/yt-dlp/yt-dlp/releases/latest/download

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$ASSET" "$BASE/$ASSET"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/SHA2-256SUMS" "$BASE/SHA2-256SUMS"
(cd "$TMP" && grep " ${ASSET}\$" SHA2-256SUMS | sha256sum -c --status) || { echo "checksum mismatch for $ASSET" >&2; exit 1; }
chmod 0755 "$TMP/$ASSET"

NEW=$("$TMP/$ASSET" --version)
OLD=$("$DEST" --version 2>/dev/null || echo none)
if [[ "$NEW" == "$OLD" ]]; then
  echo "$(date -Is) yt-dlp already at $OLD"
  exit 0
fi
mkdir -p "$(dirname "$DEST")"
if [[ $EUID -eq 0 ]]; then
  install -m 0755 -o root -g root "$TMP/$ASSET" "$DEST.new"
else
  install -m 0755 "$TMP/$ASSET" "$DEST.new"
fi
mv -f "$DEST.new" "$DEST" # atomic: running jobs keep the old inode
echo "$(date -Is) yt-dlp updated: $OLD -> $NEW"
