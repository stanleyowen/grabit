// Errors carrying a status code and a message that is safe to show to clients.
export class AppError extends Error {
  constructor(status, code, message, { cause, retryAfter } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Statuses avoid 502/504: Cloudflare replaces those response bodies with its
// own HTML error page, which would hide these messages from the client.
// Map raw yt-dlp stderr to a user-facing message. Never leak stderr itself:
// it contains server paths, versions and upstream URLs.
const PATTERNS = [
  // Egress proxy denials (see lib/egressProxy.js DENY_REASON): checked first.
  [/Egress Blocked By DNS Filter/i, 403, "dns_blocked", "Part of this site is blocked by the server's DNS filter."],
  [/Egress Blocked (Private Address|Port)/i, 403, "egress_blocked", "This link tries to reach a private or disallowed address."],
  [/max-filesize|larger than max-filesize/i, 413, "too_large", "This file is larger than the server allows."],
  [/Unsupported URL|no suitable extractor/i, 400, "unsupported", "This link isn't supported."],
  [/Private video|members-only|This video is private/i, 403, "private", "This video is private or members-only."],
  [/Sign in to confirm your age|age-restricted/i, 403, "age_restricted", "This video is age-restricted."],
  [/Sign in to confirm you.re not a bot|confirm you are not a bot/i, 503, "blocked", "The source is temporarily blocking the server. Try again later."],
  [/HTTP Error 429|Too Many Requests/i, 503, "rate_limited", "The source is rate-limiting the server. Try again later."],
  [/Video unavailable|not available|has been removed|does not exist|HTTP Error 404/i, 404, "unavailable", "This video is unavailable."],
  [/live event will begin|is not currently live|Premieres in/i, 409, "not_live", "This stream hasn't started yet."],
  [/Requested format is not available/i, 422, "format", "That quality isn't available for this video."],
  [/authentication is required|login required|log in to|requires? (an )?account|--cookies-from-browser|use --cookies/i, 403, "login_required", "This site only allows downloads for signed-in users."],
  [/HTTP Error 403|Forbidden/i, 403, "forbidden", "The site refused the request from the server."],
  [/Cannot parse data|Unable to extract|Unable to download (webpage|JSON)/i, 422, "site_changed", "Couldn't read this page. The site may have changed. Try again later."],
];

export function fromYtDlpError(error, fallback = "Couldn't process this link.") {
  if (error instanceof AppError) return error;
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  if (error?.timedOut) return new AppError(503, "timeout", "The request took too long. Try again.", { cause: error, retryAfter: 10 });
  for (const [re, status, code, message] of PATTERNS) {
    if (re.test(text)) return new AppError(status, code, message, { cause: error });
  }
  return new AppError(422, "failed", fallback, { cause: error });
}

export function isTransient(error) {
  if (error?.timedOut) return false;
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|HTTP Error 5\d\d|timed out|Connection reset|IncompleteRead|temporarily unavailable/i.test(text);
}
