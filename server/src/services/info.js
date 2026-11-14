import { config } from "../config.js";
import { fromYtDlpError } from "../lib/errors.js";
import { Semaphore } from "../lib/semaphore.js";
import { TtlCache } from "../lib/ttlCache.js";
import { assertPublicHost, normalizeUrl } from "../lib/url.js";
import { runYtDlp } from "../lib/ytdlp.js";

const cache = new TtlCache({ max: config.info.cacheMaxEntries, ttlMs: config.info.cacheTtlMs });
const inflight = new Map();
const limiter = new Semaphore(config.info.concurrency, config.info.maxQueue);

export const infoStats = () => ({ cached: cache.size, inflight: inflight.size, waiting: limiter.pending });

export async function resolveTarget(rawUrl) {
  const target = normalizeUrl(rawUrl, { allowedHosts: config.ytdlp.allowedHosts });
  await assertPublicHost(target.host);
  return target;
}

/** Video or playlist metadata, cached and de-duplicated across concurrent callers. */
export async function getInfo(rawUrl) {
  const target = await resolveTarget(rawUrl);
  const key = target.url;

  let info = cache.get(key);
  if (!info) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = limiter
        .run(() => fetchInfo(target))
        .then((result) => {
          cache.set(key, result);
          return result;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    info = await pending;
  }

  // The playlist hint depends on the URL the user pasted, not on the cached video.
  if (info.type === "video" && target.playlistUrl) return { ...info, playlistUrl: target.playlistUrl };
  return info;
}

async function fetchInfo(target) {
  const args =
    target.kind === "video"
      ? ["-J", "--no-playlist", "--", target.url]
      : ["-J", "--flat-playlist", "--playlist-items", `1:${config.info.playlistLimit}`, "--", target.url];

  let raw;
  try {
    const stdout = await runYtDlp(args, { timeoutMs: config.info.timeoutMs, captureStdout: true });
    raw = JSON.parse(stdout);
  } catch (error) {
    const mapped = fromYtDlpError(error, "Couldn't read this link.");
    if (mapped.code === "unavailable" && target.kind !== "video") {
      mapped.message = "This playlist or channel is unavailable or private.";
    }
    throw mapped;
  }

  return raw._type === "playlist" ? toPlaylist(raw, target) : toVideo(raw, target);
}

// ---------------------------------------------------------------------------

const httpsOnly = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
const num = (v) => (Number.isFinite(v) ? v : null);

function pickThumbnail(info, targetWidth) {
  const list = (info.thumbnails || []).filter((t) => httpsOnly(t.url));
  const sized = list.filter((t) => t.width).sort((a, b) => a.width - b.width);
  const pick = sized.find((t) => t.width >= targetWidth) || sized.at(-1) || list.at(-1);
  return httpsOnly(pick?.url) || httpsOnly(info.thumbnail);
}

const LABELS = { 4320: "8K", 2160: "4K", 1440: "1440p", 1080: "1080p", 720: "720p" };

function toVideo(info, target) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const sizeOf = (f) => num(f.filesize) ?? num(f.filesize_approx);

  // Best m4a audio — what the default sort (acodec:m4a) will merge in.
  const audio = formats
    .filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none")
    .sort((a, b) => Number(/^mp4a/.test(b.acodec)) - Number(/^mp4a/.test(a.acodec)) || (b.abr || 0) - (a.abr || 0))[0];
  const audioSize = audio ? sizeOf(audio) : null;

  // Group video formats by resolution (smallest dimension, like yt-dlp's "res").
  const byRes = new Map();
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === "none" || !f.height) continue;
    const res = f.width ? Math.min(f.width, f.height) : f.height;
    const prefer = (x) => [Number(/^avc1|^h264/.test(x.vcodec || "")), x.tbr || 0];
    const current = byRes.get(res);
    if (!current) byRes.set(res, f);
    else {
      const [a1, a2] = prefer(f);
      const [b1, b2] = prefer(current);
      if (a1 > b1 || (a1 === b1 && a2 > b2)) byRes.set(res, f);
    }
  }

  const options = [...byRes.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([res, f]) => {
      const vSize = sizeOf(f);
      const merged = f.acodec === "none" || !f.acodec;
      return {
        id: `${res}p`,
        kind: "video",
        label: LABELS[res] || `${res}p`,
        detail: res >= 720 ? "HD" : null,
        fps: f.fps && f.fps > 30 ? Math.round(f.fps) : null,
        size: vSize ? vSize + (merged && audioSize ? audioSize : 0) : null,
      };
    });

  const duration = num(info.duration);
  options.push(
    { id: "m4a", kind: "audio", label: "M4A", detail: "Original quality", size: audioSize },
    { id: "mp3", kind: "audio", label: "MP3", detail: "Best compatibility", size: duration ? Math.round(duration * 40_000) : null },
  );

  return {
    type: "video",
    id: String(info.id || ""),
    url: target.kind === "video" ? target.url : httpsOnly(info.webpage_url) || target.url,
    title: String(info.title || "Untitled"),
    channel: info.channel || info.uploader || null,
    duration,
    viewCount: num(info.view_count),
    uploadDate: typeof info.upload_date === "string" ? info.upload_date : null,
    thumbnail: pickThumbnail(info, 640),
    isLive: Boolean(info.is_live),
    formats: options,
  };
}

const UNAVAILABLE = /^\[(private|deleted|unavailable) video\]$/i;

function toPlaylist(info, target) {
  const entries = (info.entries || [])
    .filter(Boolean)
    .map((e, index) => {
      const url = httpsOnly(e.url) || httpsOnly(e.webpage_url);
      const title = String(e.title || "Untitled");
      return {
        index: index + 1,
        id: String(e.id || index),
        url,
        title,
        channel: e.channel || e.uploader || null,
        duration: num(e.duration),
        thumbnail: pickThumbnail(e, 320),
        available: Boolean(url) && !UNAVAILABLE.test(title),
      };
    });

  if (entries.length === 0) {
    throw fromYtDlpError(new Error("empty playlist"), "This playlist is empty or private.");
  }

  return {
    type: "playlist",
    id: String(info.id || ""),
    url: target.url,
    title: String(info.title || "Playlist"),
    channel: info.channel || info.uploader || null,
    total: num(info.playlist_count) ?? entries.length,
    truncated: entries.length >= config.info.playlistLimit,
    entries,
  };
}
