import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { AppError, fromYtDlpError, isTransient } from "../lib/errors.js";
import { log } from "../lib/logger.js";
import { runYtDlp } from "../lib/ytdlp.js";
import { resolveTarget } from "./info.js";

/*
 * Model
 * -----
 * Task   = one actual yt-dlp download for a (url, quality) pair. Shared by
 *          everyone who asks for the same thing while it's queued, running,
 *          or cached on disk — 50 people downloading the same video costs one
 *          download.
 * Ticket = one client's handle on a task (the id the client polls). Tickets
 *          are unguessable UUIDs and act as the capability to read the file.
 *          Cancelling a ticket only kills the task if nobody else needs it.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUALITY_RE = /^(\d{3,4})p$/;
const SWEEP_MS = 30_000;
const FAILED_RETENTION_MS = 5 * 60_000;

const tasks = new Map(); // key -> task
const tickets = new Map(); // ticketId -> ticket
const pending = []; // FIFO of queued tasks
const activeByClient = new Map(); // client -> Set<ticketId> (queued or running)
let running = 0;
let sweepTimer = null;
let shuttingDown = false;

export const isTicketId = (id) => typeof id === "string" && UUID_RE.test(id);

export function normalizeQuality(q) {
  if (q === "mp3" || q === "audio") return "mp3";
  if (q === "m4a") return "m4a";
  const m = typeof q === "string" && q.match(QUALITY_RE);
  if (m) {
    const h = Number(m[1]);
    if (h >= 144 && h <= 4320) return `${h}p`;
  }
  throw new AppError(400, "invalid_quality", "Pick a valid quality.");
}

export function jobStats() {
  return { running, queued: pending.length, tasks: tasks.size, concurrency: config.jobs.concurrency };
}

// ---------------------------------------------------------------------------
// Public API

export async function createJob({ url: rawUrl, quality: rawQuality, client }) {
  if (shuttingDown) throw new AppError(503, "shutting_down", "The server is restarting. Try again shortly.", { retryAfter: 15 });

  const quality = normalizeQuality(rawQuality);
  const target = await resolveTarget(rawUrl);
  if (target.kind === "playlist") {
    throw new AppError(400, "playlist", "Pick individual videos from the playlist to download.");
  }

  const active = activeByClient.get(client);
  if (active && active.size >= config.jobs.maxActivePerClient) {
    throw new AppError(429, "too_many_jobs", `You can have ${config.jobs.maxActivePerClient} downloads in progress at once.`, { retryAfter: 5 });
  }

  const key = `${quality}|${target.url}`;
  let task = tasks.get(key);
  const reusable = task && (task.status === "queued" || task.status === "running" || task.status === "ready");

  if (!reusable) {
    if (pending.length >= config.jobs.maxQueue) {
      throw new AppError(503, "busy", "The download queue is full. Try again in a few minutes.", { retryAfter: 60 });
    }
    task = newTask(key, target.url, quality);
    tasks.set(key, task);
    pending.push(task);
  } else if (task.status === "ready") {
    task.expiresAt = Math.max(task.expiresAt, Date.now() + config.jobs.fileTtlMs);
  }

  const ticket = { id: randomUUID(), task, client, createdAt: Date.now(), lastSeen: Date.now() };
  tickets.set(ticket.id, ticket);
  task.tickets.add(ticket.id);
  if (task.status === "queued" || task.status === "running") markActive(ticket);

  pump();
  return publicStatus(ticket);
}

export function getStatus(id) {
  const ticket = tickets.get(id);
  if (!ticket) return null;
  ticket.lastSeen = Date.now();
  return publicStatus(ticket);
}

export function cancelJob(id) {
  const ticket = tickets.get(id);
  if (!ticket) return false;
  dropTicket(ticket);
  return true;
}

/** Resolve a ticket to a servable file, or null. */
export function getFile(id) {
  const ticket = tickets.get(id);
  if (!ticket || ticket.task.status !== "ready") return null;
  const { task } = ticket;
  ticket.lastSeen = Date.now();
  task.expiresAt = Math.max(task.expiresAt, Date.now() + 5 * 60_000); // don't expire mid-transfer
  return { path: task.filePath, name: task.fileName, size: task.size, dir: task.id };
}

// ---------------------------------------------------------------------------
// Internals

function newTask(key, url, quality) {
  return {
    id: randomUUID(),
    key,
    url,
    quality,
    status: "queued",
    progress: { percent: 0, phase: "queued", speed: null, eta: null },
    tickets: new Set(),
    controller: null,
    filePath: null,
    fileName: null,
    size: null,
    error: null,
    attempts: 0,
    createdAt: Date.now(),
    finishedAt: null,
    expiresAt: 0,
  };
}

function publicStatus(ticket) {
  const t = ticket.task;
  const position = t.status === "queued" ? pending.indexOf(t) + 1 || null : null;
  return {
    id: ticket.id,
    status: t.status,
    position,
    progress: t.status === "ready" ? 100 : Math.floor(t.progress.percent),
    phase: t.progress.phase,
    speed: t.progress.speed,
    eta: t.progress.eta,
    fileName: t.fileName,
    size: t.size,
    expiresAt: t.status === "ready" ? t.expiresAt : null,
    error: t.error ? { code: t.error.code, message: t.error.message } : null,
  };
}

function markActive(ticket) {
  let set = activeByClient.get(ticket.client);
  if (!set) activeByClient.set(ticket.client, (set = new Set()));
  set.add(ticket.id);
}

function unmarkActive(ticket) {
  const set = activeByClient.get(ticket.client);
  if (!set) return;
  set.delete(ticket.id);
  if (set.size === 0) activeByClient.delete(ticket.client);
}

function dropTicket(ticket) {
  tickets.delete(ticket.id);
  unmarkActive(ticket);
  const { task } = ticket;
  task.tickets.delete(ticket.id);
  if (task.tickets.size === 0 && (task.status === "queued" || task.status === "running")) {
    cancelTask(task);
  }
}

function cancelTask(task) {
  if (task.status === "queued") {
    const i = pending.indexOf(task);
    if (i !== -1) pending.splice(i, 1);
    settle(task, "cancelled");
  } else if (task.status === "running") {
    task.controller?.abort(); // run() settles once the process exits
  }
}

function settle(task, status, fields = {}) {
  Object.assign(task, fields, { status, finishedAt: Date.now() });
  if (status !== "running") task.controller = null;
  for (const id of task.tickets) {
    const ticket = tickets.get(id);
    if (ticket) unmarkActive(ticket);
  }
  if (status === "cancelled" || status === "error") removeDir(task);
}

async function freeDiskBytes() {
  try {
    const s = await fsp.statfs(config.downloadsDir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

function pump() {
  while (!shuttingDown && running < config.jobs.concurrency && pending.length > 0) {
    const task = pending.shift();
    if (task.status !== "queued") continue;
    running += 1;
    task.status = "running";
    task.progress.phase = "starting";
    run(task)
      .catch((error) => {
        log.error("job crashed", { task: task.id, error: error.message });
        settle(task, "error", { error: new AppError(500, "failed", "Download failed.") });
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

async function run(task) {
  if ((await freeDiskBytes()) < config.jobs.minFreeDiskBytes) {
    log.warn("low disk space, rejecting job", { task: task.id });
    return settle(task, "error", { error: new AppError(507, "storage_full", "The server is low on storage. Try again later.") });
  }

  const dir = path.join(config.downloadsDir, task.id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o750 });
  const started = Date.now();

  while (true) {
    task.attempts += 1;
    task.controller = new AbortController();
    let finalPath = null;

    try {
      await runYtDlp(downloadArgs(task, dir), {
        timeoutMs: config.jobs.timeoutMs,
        signal: task.controller.signal,
        onLine: (line) => {
          if (line.startsWith("PROG ")) updateProgress(task, line);
          else if (line.startsWith("FILE ")) finalPath = line.slice(5);
        },
      });

      const filePath = await locateOutput(dir, finalPath);
      const stat = await fsp.stat(filePath);
      settle(task, "ready", {
        filePath,
        fileName: path.basename(filePath),
        size: stat.size,
        error: null,
        expiresAt: Date.now() + config.jobs.fileTtlMs,
        progress: { percent: 100, phase: "done", speed: null, eta: null },
      });
      log.info("job ready", { task: task.id, quality: task.quality, bytes: stat.size, ms: Date.now() - started, shared: task.tickets.size });
      return;
    } catch (error) {
      if (error.aborted) return settle(task, "cancelled");
      if (task.attempts <= config.jobs.retryLimit && isTransient(error) && !shuttingDown) {
        task.progress = { percent: 0, phase: "retrying", speed: null, eta: null };
        await new Promise((r) => setTimeout(r, 2000 * task.attempts));
        if (task.tickets.size === 0) return settle(task, "cancelled");
        continue;
      }
      return settle(task, "error", { error: fromYtDlpError(error, "Download failed.") });
    }
  }
}

function downloadArgs(task, dir) {
  const args = [
    "--no-playlist",
    "--no-mtime",
    "--newline",
    "--progress",
    "--progress-delta", "0.5",
    "--progress-template", "download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.vcodec)s",
    "--print", "after_move:FILE %(filepath)s",
    "--max-filesize", config.ytdlp.maxFileSize,
    "--concurrent-fragments", String(config.ytdlp.concurrentFragments),
    "--windows-filenames",
    "-P", dir,
    "-o", "%(title).150B.%(ext)s",
  ];

  if (task.quality === "mp3") {
    args.push("-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (task.quality === "m4a") {
    // No re-encode: just remux the native AAC stream. Zero CPU cost.
    args.push("-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a");
  } else {
    const h = task.quality.slice(0, -1);
    // Prefer H.264 + AAC so the file plays everywhere (QuickTime, iOS, TVs);
    // fall back to VP9/AV1 only where H.264 doesn't exist (1440p+).
    args.push("-f", "bv*+ba/b", "-S", `res:${h},vcodec:h264,acodec:m4a`, "--merge-output-format", "mp4");
  }

  args.push("--", task.url);
  return args;
}

const parseNum = (s) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function updateProgress(task, line) {
  const [, done, total, estimate, speed, eta, vcodec] = line.split(" ");
  const downloaded = parseNum(done);
  const size = parseNum(total) ?? parseNum(estimate);
  const partPct = downloaded !== null && size ? Math.min(100, (downloaded / size) * 100) : 0;

  // Video+audio downloads arrive as two streams; weight them so the bar never goes backwards.
  const isMergedVideo = task.quality.endsWith("p");
  let percent = partPct;
  let phase = "downloading";
  if (isMergedVideo && vcodec === "none") {
    percent = 90 + partPct * 0.1;
  } else if (isMergedVideo) {
    percent = partPct * 0.9;
  }
  if (partPct >= 100 && (!isMergedVideo || vcodec === "none")) phase = "processing";

  task.progress = {
    percent: Math.max(task.progress.percent, Math.min(99, percent)),
    phase,
    speed: parseNum(speed) !== null ? Math.round(parseNum(speed)) : null,
    eta: parseNum(eta) !== null ? Math.round(parseNum(eta)) : null,
  };
}

async function locateOutput(dir, printed) {
  const inside = (p) => {
    const rel = path.relative(dir, p);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  if (printed && inside(printed)) {
    try {
      await fsp.access(printed);
      return printed;
    } catch {}
  }
  // Fallback: the largest finished file in the task directory.
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || /\.(part|ytdl|temp|tmp)$/i.test(e.name) || /\.f\d+\./.test(e.name)) continue;
    const p = path.join(dir, e.name);
    const { size } = await fsp.stat(p);
    if (!best || size > best.size) best = { p, size };
  }
  if (!best) throw new AppError(502, "no_output", "Download finished but no file was produced.");
  return best.p;
}

function removeDir(task) {
  fsp.rm(path.join(config.downloadsDir, task.id), { recursive: true, force: true }).catch((error) =>
    log.warn("cleanup failed", { task: task.id, error: error.message }),
  );
}

function isExpired(task, now) {
  if (task.status === "ready") return task.expiresAt <= now;
  if (task.status === "error" || task.status === "cancelled") return now - task.finishedAt > FAILED_RETENTION_MS;
  return false;
}

function sweep() {
  const now = Date.now();

  // Walk tickets (not tasks) so tickets of failed tasks that were since
  // replaced by a fresh attempt are still collected.
  for (const ticket of tickets.values()) {
    const s = ticket.task.status;
    if ((s === "queued" || s === "running") && now - ticket.lastSeen > config.jobs.abandonAfterMs) {
      log.info("ticket abandoned", { task: ticket.task.id });
      dropTicket(ticket);
    } else if (isExpired(ticket.task, now)) {
      tickets.delete(ticket.id);
      unmarkActive(ticket);
    }
  }

  for (const [key, task] of tasks) {
    if (!isExpired(task, now)) continue;
    tasks.delete(key);
    if (task.status === "ready") removeDir(task);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

export async function initJobs() {
  await fsp.mkdir(config.downloadsDir, { recursive: true, mode: 0o750 });
  // State is in-memory, so anything on disk at boot is an orphan. Only touch
  // entries we created (UUID-named) in case DOWNLOADS_DIR is misconfigured.
  const entries = await fsp.readdir(config.downloadsDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((e) => UUID_RE.test(e.name))
      .map((e) => fsp.rm(path.join(config.downloadsDir, e.name), { recursive: true, force: true })),
  );
  sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref();
}

export async function shutdownJobs() {
  shuttingDown = true;
  clearInterval(sweepTimer);
  for (const task of tasks.values()) {
    if (task.status === "queued" || task.status === "running") cancelTask(task);
  }
  // Give running processes a moment to exit, then remove everything we own.
  const deadline = Date.now() + 8_000;
  while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await Promise.all([...tasks.values()].map((t) => fsp.rm(path.join(config.downloadsDir, t.id), { recursive: true, force: true })));
}
