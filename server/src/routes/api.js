import { Router } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { RateLimiter } from "../lib/rateLimit.js";
import { getInfo, infoStats } from "../services/info.js";
import { cancelJob, createJob, getFile, getStatus, isTicketId, jobStats } from "../services/jobs.js";

export const limiters = {
  info: new RateLimiter(config.rateLimits.info),
  create: new RateLimiter(config.rateLimits.create),
  status: new RateLimiter(config.rateLimits.status),
  file: new RateLimiter(config.rateLimits.file),
};

const MAX_BATCH = 50;
const notFound = () => new AppError(404, "not_found", "This download has expired or doesn't exist.");

function ticketParam(req) {
  if (!isTicketId(req.params.id)) throw notFound();
  return req.params.id;
}

export const api = Router();

api.get("/health", (_req, res) => {
  res.json({ ok: true, jobs: jobStats(), info: infoStats() });
});

api.post("/info", limiters.info.middleware(), async (req, res) => {
  res.json(await getInfo(req.body?.url));
});

api.post("/jobs", limiters.create.middleware(), async (req, res) => {
  const job = await createJob({ url: req.body?.url, quality: req.body?.quality, client: req.clientIp ?? req.ip });
  res.status(201).json(job);
});

// Batch status: one request for a whole playlist instead of one per video.
api.get("/jobs", limiters.status.middleware(), (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .filter(isTicketId)
    .slice(0, MAX_BATCH);
  const jobs = {};
  for (const id of ids) jobs[id] = getStatus(id);
  res.json({ jobs });
});

api.get("/jobs/:id", limiters.status.middleware(), (req, res) => {
  const status = getStatus(ticketParam(req));
  if (!status) throw notFound();
  res.json(status);
});

api.delete("/jobs/:id", limiters.status.middleware(), (req, res) => {
  cancelJob(ticketParam(req));
  res.status(204).end();
});

api.get("/jobs/:id/file", limiters.file.middleware(), (req, res, next) => {
  const file = getFile(ticketParam(req));
  if (!file) throw notFound();

  res.attachment(file.name); // RFC 6266 Content-Disposition incl. UTF-8 filename*
  res.set("Cache-Control", "private, no-store");

  if (config.xAccelPrefix) {
    // nginx streams the file with sendfile(); Node never touches the bytes.
    const rel = `${encodeURIComponent(file.dir)}/${encodeURIComponent(file.name)}`;
    res.set("X-Accel-Redirect", `${config.xAccelPrefix.replace(/\/?$/, "/")}${rel}`);
    return res.end();
  }

  // dotfiles must be "allow": send() checks every segment of the absolute
  // path, so "deny" rejects files under e.g. ~/.local/share and titles that
  // start with a dot. The path is server-generated and confined to the task
  // directory (see locateOutput), so there is nothing to deny here.
  res.sendFile(file.path, { dotfiles: "allow", acceptRanges: true, lastModified: false }, (err) => {
    if (err && !res.headersSent) next(err);
  });
});
