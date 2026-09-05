/**
 * Refuse to reach into private address space.
 *
 * An audit fetches whatever URL a customer submits, which is the product,
 * and also the textbook shape of server-side request forgery: a submitted
 * `http://169.254.169.254/` or `http://10.0.0.5/` would have our server read
 * from the cloud metadata service or a neighbour. So the host is resolved
 * and every answer checked before the request goes out, and the final URL
 * is checked again after redirects, since a public name can bounce inward.
 *
 * Same rules as outreach's mailbox discovery, kept here so the audit path
 * does not import that module's dependencies.
 */

import dns from "node:dns/promises";
import net from "node:net";

export function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(addr)) {
    const v6 = addr.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export class PrivateTargetError extends Error {
  constructor(public readonly host: string) {
    super(`refusing to fetch ${host}: it resolves to a private address`);
    this.name = "PrivateTargetError";
  }
}

/**
 * Throw unless every address the URL's host resolves to is public.
 *
 * `localhost` and bare IPs are covered; a name that does not resolve is
 * refused too, since there is nothing public to reach.
 */
export async function assertPublicTarget(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else if (host === "localhost" || host.endsWith(".localhost")) {
    addrs = ["127.0.0.1"];
  } else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      addrs = [];
    }
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new PrivateTargetError(host);
}
