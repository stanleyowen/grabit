import net from "node:net";
import { AppError } from "./errors.js";
import { classifyAddresses, resolveHost } from "./resolver.js";
import { TtlCache } from "./ttlCache.js";

const MAX_URL_LENGTH = 2048;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{2,64}$/;
const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);

// Non-public address space. Requests into these ranges would let a caller use
// the server to reach internal services (SSRF).
// Separate lists per family: Node's BlockList maps IPv4 lookups onto IPv6
// rules (::ffff:0:0/96), so a mixed list would flag every IPv4 address.
const blocked4 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked4.addSubnet(addr, prefix, "ipv4");
const blocked6 = new net.BlockList();
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked6.addSubnet(addr, prefix, "ipv6");

// ::ffff:a.b.c.d or ::ffff:XXXX:XXXX (the form WHATWG URL normalises to).
function mappedIPv4(ip) {
  const m = ip.match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/i);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blocked4.check(ip, "ipv4");
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    if (v4) return blocked4.check(v4, "ipv4");
    return blocked6.check(ip, "ipv6");
  }
  return true; // not an IP at all -> treat as unsafe
}

function hostAllowed(host, allowedHosts) {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Parse and normalise a user-supplied URL.
 * Returns { url, kind: "video" | "playlist" | "unknown", playlistUrl? }.
 * Throws AppError(400) for anything unsafe or malformed.
 */
export function normalizeUrl(raw, { allowedHosts = [] } = {}) {
  const invalid = () => new AppError(400, "invalid_url", "Enter a valid http(s) link.");
  if (typeof raw !== "string") throw invalid();
  const input = raw.trim();
  if (!input || input.length > MAX_URL_LENGTH) throw invalid();

  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw invalid();
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") throw invalid();
  if (u.username || u.password) throw invalid();
  if (u.port && u.port !== "80" && u.port !== "443") throw invalid();

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) throw invalid();
  const bareHost = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bareHost) && isPrivateAddress(bareHost)) throw invalid();

  if (YT_HOSTS.has(host)) {
    const yt = normalizeYouTube(u, host);
    if (!hostAllowed("youtube.com", allowedHosts) && !hostAllowed(host, allowedHosts)) {
      throw new AppError(400, "unsupported", "This site isn't supported.");
    }
    return yt;
  }

  if (!hostAllowed(host, allowedHosts)) {
    throw new AppError(400, "unsupported", "This site isn't supported.");
  }

  u.hash = "";
  u.hostname = host;
  return { url: u.href, kind: "unknown", host };
}

function normalizeYouTube(u, host) {
  const list = u.searchParams.get("list");
  const validList = list && YT_LIST.test(list) ? list : null;
  const playlistUrl = validList ? `https://www.youtube.com/playlist?list=${validList}` : null;

  let id = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/")[1];
  } else if (u.pathname === "/watch") {
    id = u.searchParams.get("v");
  } else {
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
    if (m) id = m[1];
  }

  if (id && YT_ID.test(id)) {
    return { url: `https://www.youtube.com/watch?v=${id}`, kind: "video", host: "www.youtube.com", playlistUrl };
  }
  if (playlistUrl) {
    return { url: playlistUrl, kind: "playlist", host: "www.youtube.com" };
  }
  // Channel pages etc. — let yt-dlp treat them as playlists.
  if (/^\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/.test(u.pathname)) {
    return { url: `https://www.youtube.com${u.pathname}`, kind: "playlist", host: "www.youtube.com" };
  }
  throw new AppError(400, "invalid_url", "That doesn't look like a valid YouTube link.");
}

const dnsCache = new TtlCache({ max: 2000, ttlMs: 5 * 60_000 });

const UNREACHABLE = () => new AppError(400, "invalid_url", "That address isn't reachable.");
const DNS_BLOCKED = () =>
  new AppError(400, "dns_blocked", "This site is blocked by the server's DNS filter.");

/** Resolve the hostname and refuse private/internal targets (DNS-based SSRF). */
export async function assertPublicHost(host) {
  if (YT_HOSTS.has(host)) return;
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw new AppError(400, "invalid_url", "Enter a valid http(s) link.");
    return;
  }
  let verdict = dnsCache.get(host);
  if (!verdict) {
    try {
      verdict = classifyAddresses(await resolveHost(bare));
    } catch {
      throw new AppError(400, "invalid_url", "That address couldn't be found.");
    }
    dnsCache.set(host, verdict);
  }
  if (verdict === "blocked") throw DNS_BLOCKED();
  if (verdict !== "ok") throw UNREACHABLE();
}
