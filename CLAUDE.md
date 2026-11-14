# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Grabit, a video downloader: a React SPA (`client/`) and a Node/Express API (`server/`) that wraps yt-dlp. They're separate npm projects (npm, not yarn) with no root package.json. Node >= 22.12.

## Commands

```bash
# server
cd server && npm install
npm run dev                      # node --watch, loads server/.env if present; 127.0.0.1:3003
npm test                         # node:test, all of test/**/*.test.js — offline, uses a fake yt-dlp
node --test test/lib.test.js     # one file
node --test --test-name-pattern="job lifecycle" test/api.test.js   # one test

# client
cd client && npm install
npm run dev                      # Vite on :5173, proxies /api to VITE_API_PROXY_TARGET (default http://localhost:3003)
npm run build                    # runs scripts/generate-netlify.js, then vite build
```

There's no linter configured. Local dev needs `yt-dlp`, `ffmpeg` and `deno` on PATH; yt-dlp needs a JS runtime for YouTube.

## Server architecture (`server/src`)

Config is read once from env in `config.js`, which also documents every option. `server/.env.example` lists them for operators. Tests set env vars *before* dynamically importing modules, because config is frozen at import time.

The request path goes `app.js` (middleware) → `routes/api.js` → services.

- **`services/info.js`**: `/api/info` metadata. It caches results in a TTL LRU, de-duplicates identical in-flight lookups (many callers share one promise), and bounds concurrency with a `Semaphore` that has a bounded wait queue (it returns 503 instead of queuing forever). It turns yt-dlp's JSON into a trimmed `{type: "video"|"playlist", ...}` shape, including per-quality size estimates.
- **`services/jobs.js`**: the download manager. Read the header comment in that file first. The core split:
  - A **Task** is one real yt-dlp download, keyed by `quality|normalizedUrl`. It's shared by everyone asking for the same thing while it's queued, running, or ready on disk for `FILE_TTL_MS`.
  - A **Ticket** is one client's handle on a Task. Its random UUID is what the client polls, and it acts as the capability to fetch the file. Cancelling a ticket only kills the Task when no tickets remain.

  Tasks go through a FIFO `pending` queue with a concurrency limit. Each client gets an active-ticket cap. A disk-space guard runs before each start. A 30s sweep expires files, collects tickets, and cancels tickets nobody has polled for `ABANDON_AFTER_MS`. All state is **in memory**, so the server must run as a single process (never PM2 cluster mode), and a restart drops in-flight jobs. On boot it deletes UUID-named directories in `DOWNLOADS_DIR`.
- **`lib/ytdlp.js`**: the only place that spawns yt-dlp. It always adds `--ignore-config` and `--use-extractors default,-generic`. It spawns `detached`, so a timeout or abort kills the whole process group (including ffmpeg), passes only an allow-listed env to the child, and gives each process its own private copy of the cookies file. Downloads report progress through a custom `--progress-template` (`PROG ...` lines) and print the final path with `--print after_move:FILE ...`. `jobs.js` parses both from stdout.
- **`lib/url.js`**: all user URLs go through `normalizeUrl` and then `assertPublicHost` (SSRF defence: private, IPv4-mapped and DNS-resolved addresses are rejected). YouTube URLs are canonicalised to `https://www.youtube.com/watch?v=ID`, which is what makes the caches and task sharing hit. Note Node's `BlockList` quirk: IPv4 checks match IPv6 `::ffff:0:0/96` rules, so the v4 and v6 lists are kept separate.
- **`lib/errors.js`**: `AppError(status, code, message)` carries a client-safe message. `fromYtDlpError` maps stderr patterns to friendly errors; raw stderr must never reach a response.
- **Client IP:** `req.clientIp` is set in `app.js`. `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) is honoured only when the TCP peer is loopback. Rate limiters (`lib/rateLimit.js`, an in-memory token bucket) and per-client job caps key on `req.clientIp`.
- **File serving** (`GET /api/jobs/:id/file`): `res.sendFile`, or an `X-Accel-Redirect` header when `X_ACCEL_PREFIX` is set and nginx sits in front.

API surface: `POST /api/info`, `POST /api/jobs`, `GET /api/jobs?ids=a,b` (batch status, max 50), `GET|DELETE /api/jobs/:id`, `GET /api/jobs/:id/file`, `GET /api/health`, `GET /health`. The client and server change together: deploy both, because there's no backward compatibility with the old `/download` and `/status` endpoints.

`test/fixtures/fake-ytdlp.mjs` stands in for yt-dlp (`YTDLP_PATH` points at it). URL content drives its behaviour: `unavailable` → error, `slow` → slow progress, `playlist` → playlist JSON. Extend it when adding yt-dlp-dependent features.

## Client architecture (`client/src`)

- **`hooks/useDownloads.js`** is the client-side download engine. State lives in a ref that updates synchronously (`dispatch` writes the ref, then calls `setItems`), so the async loop never resubmits an item whose create request is still in flight. Don't convert it to plain `useReducer`. One `setTimeout` loop:
  - submits `pending` items, at most `MAX_IN_FLIGHT` at a time, honouring `Retry-After` on 429/503;
  - polls all active jobs with one batched request, at an adaptive interval that slows down when the tab is hidden;
  - auto-saves files by clicking a hidden anchor.

  The list persists in `sessionStorage`.
- **`lib/api.js`**: the fetch wrapper. It only parses JSON when the content-type says JSON (Safari's parse error is meaningless to users) and throws `ApiError`, which has a `retryable` flag. `VITE_API_BASE` and `VITE_DOWNLOAD_BASE` let the client bypass the Netlify proxy.
- **Styling:** Tailwind v4, CSS-first, no `tailwind.config.js`. Semantic colour tokens (`bg`, `surface`, `subtle`, `line`, `fg`, `muted`, `accent`, `ok`, `danger`) are defined in `index.css` `@theme` and swapped under `.dark`. Use those tokens, not raw palette colours. `public/theme.js` applies the theme before first paint; it's an external file so the CSP needs no `'unsafe-inline'` for scripts.
- **`scripts/generate-netlify.js`** writes `public/_redirects` (the `/api` proxy) and `public/_headers` (CSP, `connect-src` derived from `VITE_API_BASE`/`VITE_DOWNLOAD_BASE`) at build time. These files are generated; edit the script, not the output.

## Deployment

The frontend is on Netlify and builds from `main`. The backend runs on a remote Ubuntu server under **PM2 as a normal user, without sudo**, behind a **Cloudflare Tunnel**. There's no nginx in that setup. Host-specific details (SSH target, what else runs on the box) are in `CLAUDE.local.md`, which is gitignored because this repo is public.

- `deploy/deploy-pm2.sh user@host` is the path used in production. It runs local tests, then rsyncs to `~/server/.youtube-downloader-release`. It installs yt-dlp and deno (checksum-verified) into `~/.local/opt/video-downloader/bin` and smoke-tests the **exact PM2 config** on port 3013. It then swaps into `~/server/youtube-downloader`, restarts PM2 app `youtube-dl`, health-checks, and rolls back automatically on failure. It also ensures the daily yt-dlp update cron entry.
- `server/ecosystem.config.cjs` sets the structural env: `HOST=127.0.0.1`, the paths, and `CLIENT_IP_HEADER`. It uses an absolute `interpreter` because node comes from nvm; a minimal PATH without it breaks PM2 with `spawn node ENOENT`. Tunables live in `~/.config/video-downloader/env` on the server; PM2 env overrides that file.
- Downloads go to `~/.local/share/video-downloader/downloads`. The previous release is kept as `~/server/.youtube-downloader-prev-*`.
- `deploy/deploy.sh`, `install.sh`, `nginx.conf` and the `*.service`/`*.timer` units are the alternative root/systemd + nginx setup. They aren't what runs on the current server.
- **The user manages Cloudflare Tunnel routing and DNS themselves.** Don't edit cloudflared config, create DNS routes, or restart cloudflared. The app side only needs `CORS_ORIGINS` in `~/.config/video-downloader/env` (if the frontend calls the API cross-origin) and the Netlify `VITE_*` env vars.
- Never commit host-specific infrastructure details (IPs, usernames, other services) to this public repo. Put them in `CLAUDE.local.md`.
