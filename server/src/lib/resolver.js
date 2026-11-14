import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { isPrivateAddress } from "./url.js"; // circular import is safe: only used at call time

/*
 * Single DNS resolution path for the initial URL check and the egress proxy,
 * so both always agree on what a host resolves to.
 *
 * DNS_SERVERS empty  -> the system resolver (respects /etc/hosts and local
 *                       DNS filters such as AdGuard/Pi-hole).
 * DNS_SERVERS=a,b    -> query those servers directly (e.g. 1.1.1.1,9.9.9.9).
 */
let resolver = null;
if (config.dnsServers.length) {
  resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(config.dnsServers);
}

export async function resolveHost(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return [bare];
  if (!resolver) {
    return (await dns.lookup(bare, { all: true, verbatim: true })).map((a) => a.address);
  }
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(bare), resolver.resolve6(bare)]);
  const ips = [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
  if (ips.length === 0) throw Object.assign(new Error(`cannot resolve ${bare}`), { code: "ENOTFOUND" });
  return ips;
}

// DNS filters (AdGuard, Pi-hole, NextDNS) answer blocked names with 0.0.0.0 / ::.
const SINKHOLE = new Set(["0.0.0.0", "::"]);

/** "ok" | "blocked" (DNS filter sinkhole) | "private" (internal address). */
export function classifyAddresses(ips) {
  if (ips.length === 0) return "private";
  if (ips.every((ip) => SINKHOLE.has(ip))) return "blocked";
  return ips.some((ip) => isPrivateAddress(ip)) ? "private" : "ok";
}
