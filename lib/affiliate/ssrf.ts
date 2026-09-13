// Fetching a URL somebody typed is the one thing this feature cannot avoid:
// a merchant's descriptor, an affiliate's profile, a join endpoint, a ledger.
// So every outbound request goes through here. A URL is fetched only when it
// is http(s) on a default port, its host is not a loopback, link-local or
// private name, and every address it resolves to is public. Redirects are
// followed by hand so each hop gets the same check.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".arpa"];

/** True for any IPv4 or IPv6 address that must never be fetched. Pure, for tests. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
    if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) return true; // v4-mapped / NAT64
    return false;
  }
  return true; // not an address at all
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Shape check with no network: scheme, port, host name. Pure, for tests. */
export function checkUrlShape(input: string): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "only http and https" };
  if (url.username || url.password) return { ok: false, error: "credentials in the URL" };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, error: "non-standard port" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, error: "no host" };
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) return { ok: false, error: "private address" };
    return { ok: true, url };
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".")) {
    return { ok: false, error: "not a public host" };
  }
  return { ok: true, url };
}

/** The full check: shape, then every resolved address. */
export async function publicUrl(input: string): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  const shaped = checkUrlShape(input);
  if (!shaped.ok) return shaped;
  const host = shaped.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return shaped;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: `${host} does not resolve` };
  }
  if (!addresses.length) return { ok: false, error: `${host} does not resolve` };
  if (addresses.some((a) => isPrivateAddress(a.address))) return { ok: false, error: `${host} resolves to a private address` };
  return shaped;
}

const MAX_HOPS = 3;

/**
 * fetch() for URLs we did not choose. Redirects are followed by hand, each
 * hop re-checked, so a public host cannot bounce us onto a private one.
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let current = input;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const checked = await publicUrl(current);
    if (!checked.ok) throw new Error(`refused ${current}: ${checked.error}`);
    const res = await fetch(checked.url.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop === MAX_HOPS) throw new Error(`too many redirects from ${input}`);
      current = new URL(location, checked.url).toString();
      // A redirect turns a POST into a GET for 301/302/303; we never follow one on a POST.
      if (init.method && init.method !== "GET") throw new Error(`refused a redirect on ${init.method} to ${current}`);
      continue;
    }
    return res;
  }
  throw new Error(`too many redirects from ${input}`);
}
