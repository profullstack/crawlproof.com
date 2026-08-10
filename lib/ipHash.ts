import crypto from "node:crypto";
import { env } from "./env";

// Single source of truth for turning a client IP into a storable identifier.
//
// This replaces two divergent implementations that had drifted apart:
//   * lib/rateLimit.ts — sha256("crawlproof:" + ip), a hardcoded constant
//     prefix, which is a pepper in name only since it lives in the source.
//   * lib/ads/serve.ts — sha256(ip), no prefix at all.
//
// Neither was anonymisation. IPv4 is 2^32 addresses, so the entire space can be
// enumerated against a truncated SHA-256 in minutes on commodity hardware; an
// unsalted digest of an IP is a reversible encoding of that IP, not a
// pseudonym. A server-side secret salt is the thing that makes it one-way in
// practice, which matters here because ip_hash is the only identifier the ad
// network has for terminal traffic (curl has no localStorage) and for the ~69%
// of web impressions that historically arrived with no visitor id.
//
// Two exported variants over one implementation, because the callers need
// opposite properties from the same primitive:
//
//   hashIp()          Stable over time. Abuse caps look back 24h and longer
//                     (checkAnonymousLimit), so a rotating salt would silently
//                     refill every anonymous quota at the rotation boundary —
//                     a quota bypass, not a privacy win.
//   hashIpRotating()  Salt changes daily. Ad metering only needs to recognise
//                     an IP within hours (6h click dedupe, frequency capping).
//                     Past that window, being *able* to re-identify a visitor
//                     is a liability rather than a feature, so the capability
//                     is designed to expire on its own.
//
// Rotation makes long-term correlation impossible even against a full database
// leak, while leaving the short-window behaviour the ad network actually uses
// intact.

const LEGACY_PREFIX = "crawlproof:";
const DAY_MS = 86_400_000;

function sha(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
}

let warned = false;
function salt(): string {
  const s = env.ipHashSalt;
  if (s) return s;
  // Deliberately does not throw. An unsalted hash is a weakness; a hard failure
  // on every request that touches an IP is an outage of both ad serving and
  // rate limiting. Warn once — enough to be visible in logs, quiet enough not
  // to flood them at request volume.
  if (!warned) {
    warned = true;
    console.warn(
      "[ipHash] IP_HASH_SALT is unset — falling back to the legacy unsalted digest. Set it in production.",
    );
  }
  return "";
}

// NUL-joined so a salt ending in digits can't collide with an IP starting with
// them; no component of the input can bleed into the next.
function join(parts: string[]): string {
  return parts.join("\u0000");
}

/**
 * Stable, salted hash of a client IP. Use for abuse caps and anything that
 * looks back more than a day.
 *
 * A missing IP hashes to a shared "unknown" bucket on purpose: for rate
 * limiting, lumping unattributable requests together is the conservative
 * choice.
 */
export function hashIp(ip: string | null | undefined): string {
  const v = ip ?? "unknown";
  const s = salt();
  // With no salt configured this reproduces the historical digest byte for
  // byte, so an environment that hasn't set IP_HASH_SALT yet doesn't invalidate
  // every stored hash and hand each rate-limited visitor a fresh quota.
  return s ? sha(join([s, LEGACY_PREFIX + v])) : sha(LEGACY_PREFIX + v);
}

function dayIndex(at: Date): number {
  return Math.floor(at.getTime() / DAY_MS);
}

function rotatingFor(ip: string, day: number): string {
  return sha(join([salt(), `day:${day}`, ip]));
}

/**
 * Daily-rotating salted hash of a client IP, for ad metering.
 *
 * Returns null for a missing IP rather than bucketing to a shared constant —
 * the opposite of hashIp, and load-bearing: every unattributable ad request
 * sharing one hash would make them all look like duplicates of each other and
 * invalidate legitimate clicks wholesale.
 */
export function hashIpRotating(
  ip: string | null | undefined,
  at: Date = new Date(),
): string | null {
  if (!ip) return null;
  return rotatingFor(ip, dayIndex(at));
}

/**
 * Every rotating hash an IP could have been stored under across `lookbackMs`.
 *
 * Dedupe windows don't respect the rotation boundary: a 6h click window that
 * starts at 23:00 has to match rows written under yesterday's salt. Querying
 * only today's hash would make every dedupe check silently miss for the first
 * hours of each day — precisely when a duplicate click is most likely to be
 * someone probing the boundary. Newest first.
 */
export function rotatingIpHashCandidates(
  ip: string | null | undefined,
  lookbackMs: number,
  at: Date = new Date(),
): string[] {
  if (!ip) return [];
  const today = dayIndex(at);
  const earliest = dayIndex(new Date(at.getTime() - Math.max(0, lookbackMs)));
  const out: string[] = [];
  for (let day = today; day >= earliest; day--) out.push(rotatingFor(ip, day));
  return out;
}
