# syntax=docker/dockerfile:1
# Build context: server/  (see compose.yaml)
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-trixie-slim
# ffmpeg for merging/remuxing. yt-dlp and deno are NOT baked in: they are bind-mounted
# from ~/.local/opt/video-downloader/bin so the daily update-ytdlp.sh cron keeps working.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chmod=0444 package.json ./
COPY --chmod=0555 src ./src
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3003/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--max-old-space-size=512", "src/index.js"]
