# Video Downloader

Download videos, audio and playlists in any quality. React frontend, Node.js API backed by [yt-dlp](https://github.com/yt-dlp/yt-dlp), built to serve many users at once from a single Ubuntu box.

## Architecture

```
Browser ──► Netlify (static site) ──/api──► nginx (TLS, rate limit) ──► Node API (127.0.0.1:3003)
   ▲                                          │                             │
   └──────── file bytes via X-Accel-Redirect ─┘                             ├─ info service: LRU cache + in-flight de-dupe
                                                                            ├─ job manager: shared tasks, FIFO queue, per-client caps
                                                                            └─ yt-dlp / ffmpeg child processes (timeouts, process-group kill)
```

**Why it scales**

| Technique | Effect |
|---|---|
| Metadata cache (15 min LRU) + in-flight coalescing | 50 people pasting the same link at once → 1 yt-dlp call. Cached lookups ~1 ms. |
| Shared download tasks | Same video + quality requested by many users → downloaded once, file shared for 20 min. |
| One yt-dlp process per download | The old version spawned yt-dlp twice per download (once just to read the title). |
| Bounded concurrency + bounded queues | Spikes get a clean `503 Retry-After` instead of exhausting CPU/RAM. |
| Batched status polling | The UI polls every active job in **one** request, backs off when idle/hidden. |
| H.264 + AAC preferred, M4A remux | Files play everywhere; M4A needs zero CPU (no re-encode). |
| nginx `X-Accel-Redirect` | Node authorises, nginx streams the bytes with `sendfile`. |

**Security**

- No shell, args passed as an array with `--` terminator, `--ignore-config`, strict quality whitelist.
- SSRF: only http(s) on default ports; private/link-local/metadata IPs rejected (incl. DNS resolution and IPv4-mapped IPv6); yt-dlp's `generic` extractor disabled; optional `ALLOWED_HOSTS`.
- TLS verification always on (the old `--no-check-certificates` fallback is gone).
- Errors are mapped to safe messages — stderr/paths never reach clients.
- Per-IP token-bucket rate limits, per-client active-job cap, 8 KB body limit, strict CORS allow-list, security headers, CSP on the frontend.
- Disk guard (min free space, max file size, TTL cleanup, orphan cleanup on boot).
- Child processes get a minimal environment (no secrets leak), hard timeouts, and are killed as a process group.
- systemd sandbox: dedicated user, read-only code, `ProtectSystem=strict`, no capabilities, syscall filter, memory/task limits.
- yt-dlp auto-updates daily with SHA-256 verification.

## Local development

Prerequisites: Node 22.12+, `yt-dlp`, `ffmpeg`, and `deno` (yt-dlp needs a JS runtime for YouTube).

```bash
# macOS
brew install yt-dlp ffmpeg deno

cd server && npm install && npm run dev     # http://127.0.0.1:3003
cd client && npm install && npm run dev     # http://localhost:5173 (proxies /api to :3003)
```

Set `VITE_API_PROXY_TARGET=http://localhost:3003` in `client/.env` to use your local API.

Tests (no network needed — uses a fake yt-dlp):

```bash
cd server && npm test
```

## Deploying the backend (Ubuntu over SSH)

First time (installs Node 24, ffmpeg, deno, yt-dlp, service user, systemd units, nginx site):

```bash
DOMAIN=yt-dl.example.com deploy/deploy.sh user@your-server --bootstrap
ssh user@your-server 'sudo certbot certonly --nginx -d yt-dl.example.com && sudo nginx -t && sudo systemctl reload nginx'
```

Every deploy after that (runs tests, uploads, `npm ci`, restarts, health-checks):

```bash
deploy/deploy.sh user@your-server
```

Configuration lives in `/etc/video-downloader/env` — see [`server/.env.example`](server/.env.example) for every option.

Useful commands on the server:

```bash
journalctl -u video-downloader -f          # logs (JSON lines)
systemctl status video-downloader
curl -s localhost:3003/api/health          # queue / cache stats
sudo systemctl start yt-dlp-update         # update yt-dlp now
```

### Client IPs behind proxies

Rate limits are per client IP, so the API must see real IPs:

- **Recommended:** have the frontend call the API directly. Set `VITE_API_BASE=https://yt-dl.example.com/api` on Netlify and `CORS_ORIGINS=https://your-site.netlify.app` on the server.
- At minimum, set `VITE_DOWNLOAD_BASE=https://yt-dl.example.com/api` so large files skip the Netlify proxy (needs no CORS).
- If you keep the Netlify `/api` proxy, every request arrives from Netlify's IPs. Set `TRUST_PROXY=2` and relax the nginx `limit_req` zones, or users will share limits.

## Frontend (Netlify)

Build command `npm run build`, publish directory `client/dist`. The build generates `_redirects` and `_headers` (CSP, HSTS, immutable asset caching) from the `VITE_*` env vars — see [`client/.env.example`](client/.env.example).

## Disclaimer

For personal use only. Respect creators, the source sites' Terms of Service and copyright law.
