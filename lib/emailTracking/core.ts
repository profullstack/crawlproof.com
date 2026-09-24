// Email tracking: the pure half. Signatures, URL checks, the machine-open
// heuristic and the pixel bytes. No database, so every rule here is testable
// without a stub.
//
// The URL contract (shared with the myna CLI; do not change the shapes):
//
//   GET  /t/<trackingId>/o.png?m=<msgId>&c=<campaign>&v=<variant>
//   GET  /t/<trackingId>/c?u=<url>&m=&c=&v=&s=<sig>      sig over u
//   GET  /t/<trackingId>/u?m=&c=&e=<email>&s=<sig>       sig over lowercase(e)
//   POST /t/<trackingId>/u?...                            (RFC 8058 one-click)
//   GET  /api/v1/tracking/<trackingId>/events?since=&type=   Bearer <secret>
//
// sig = first 32 hex chars of HMAC-SHA256(secret, value).

import crypto from "node:crypto";
import { isIP } from "node:net";
import { PROXY_AGENTS } from "@/lib/outreach/openTracking";

export const SIG_HEX_LENGTH = 32;

export const EVENT_TYPES = ["open", "click", "unsubscribe"] as const;
export type EmailEventType = (typeof EVENT_TYPES)[number];

export function isEventType(v: unknown): v is EmailEventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}

/** 1x1 fully transparent RGBA PNG (68 bytes). */
export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

/** Headers for the pixel: every layer is asked not to cache, or one fetch is one open forever. */
export const PIXEL_HEADERS: Record<string, string> = {
  "content-type": "image/png",
  "content-length": String(PIXEL_PNG.length),
  "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
  pragma: "no-cache",
  expires: "0",
};

/** HMAC-SHA256(secret, value), hex, truncated to 32 chars. */
export function sign(secret: string, value: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(value, "utf8")
    .digest("hex")
    .slice(0, SIG_HEX_LENGTH);
}

/** The value an unsubscribe signature covers. */
export function unsubscribeSigValue(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Constant-time check of `sig` against every secret that may have signed it
 * (the current one, and the one before the last rotation). Case-insensitive
 * on the hex so an upper-casing mail client does not break a link.
 */
export function verifySig(
  secrets: ReadonlyArray<string | null | undefined>,
  value: string,
  sig: string | null | undefined,
): boolean {
  if (!sig) return false;
  const given = sig.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(given)) return false;
  const givenBuf = Buffer.from(given, "utf8");
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const want = Buffer.from(sign(secret, value), "utf8");
    // Evaluate every candidate so timing does not say which one matched.
    if (crypto.timingSafeEqual(want, givenBuf)) ok = true;
  }
  return ok;
}

/** Constant-time comparison of a bearer token with the stored secret. */
export function secretMatches(stored: string | null | undefined, given: string | null | undefined): boolean {
  if (!stored || !given) return false;
  const a = crypto.createHash("sha256").update(stored).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/** A redirect target: absolute http(s) only, nothing else. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

/** Plausible single address. Deliberately loose: the signature is the real check. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = unsubscribeSigValue(raw ?? "");
  if (!e || e.length > 320) return null;
  if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(e)) return null;
  return e;
}

/** A tracking id as the migration mints it, or near enough to be worth a lookup. */
export function isPlausibleTrackingId(id: string | null | undefined): id is string {
  return !!id && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

/** m / c / v: short free text from a query string. Empty becomes null. */
export function tag(raw: string | null | undefined, max = 200): string | null {
  if (raw == null) return null;
  const t = raw.trim().slice(0, max);
  return t ? t : null;
}

/**
 * Railway supplies X-Real-IP. Mirrors lib/crawl-limits.ts sourceIp without
 * pulling its Redis client into the pixel path.
 */
export function clientIp(headers: Headers): string | null {
  const ip = headers.get("x-real-ip")?.trim();
  return ip && isIP(ip) ? ip : null;
}

/** How soon after a message was first seen a repeat open is a scanner, not a person. */
export const MACHINE_OPEN_WINDOW_MS = 5_000;

/**
 * Whether a user agent belongs to something that fetches images on the
 * recipient's behalf (Gmail's image proxy, Yahoo's, security gateways) or is
 * Apple Mail Privacy Protection, which prefetches every image on delivery and
 * identifies itself only as a bare "Mozilla/5.0". Reuses the outreach pixel's
 * list (lib/outreach/openTracking.ts) so the two never disagree.
 */
export function isMachineAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim().toLowerCase();
  if (!ua) return true;
  if (ua === "mozilla/5.0") return true;
  return PROXY_AGENTS.some((p) => ua.includes(p));
}

/**
 * The open heuristic: a proxy user agent, or an open arriving within a few
 * seconds of the first time this message id was seen at all. The first
 * sighting itself cannot be judged by timing (sends are not known here).
 */
export function isLikelyMachineOpen(input: {
  userAgent: string | null | undefined;
  firstSeenAt: Date | null;
  now: Date;
}): boolean {
  if (isMachineAgent(input.userAgent)) return true;
  if (!input.firstSeenAt) return false;
  const elapsed = input.now.getTime() - input.firstSeenAt.getTime();
  return elapsed >= 0 && elapsed < MACHINE_OPEN_WINDOW_MS;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A tiny standalone HTML page for the click and unsubscribe routes. */
export function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--muted:#666;--card:#fff;--border:#e5e5e5;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#eee;--muted:#9a9a9a;--card:#151517;--border:#2a2a2e;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:32rem;margin:0 auto;padding:3rem 1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:1.25rem}
h1{font-size:1.4rem;margin:0 0 .75rem}
p{margin:.5rem 0;color:var(--muted)}
code{display:block;word-break:break-all;background:var(--bg);border:1px solid var(--border);border-radius:.5rem;padding:.6rem;margin:.75rem 0;color:var(--fg);font-size:.9rem}
button{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:.5rem;padding:.6rem 1.1rem;cursor:pointer}
footer{margin-top:1.5rem;font-size:.8rem;color:var(--muted)}
</style>
</head>
<body><main><div class="card">${bodyHtml}</div><footer>Link handling by CrawlProof</footer></main></body>
</html>`;
}

/** Headers for every HTML page the tracking routes serve. */
export const HTML_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

/** One event as the events API returns it: url / email / machine only where they mean something. */
export function shapeEvent(e: {
  type: EmailEventType;
  m: string | null;
  c: string | null;
  v: string | null;
  url: string | null;
  email: string | null;
  machine: boolean;
  at: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.type, m: e.m, c: e.c, v: e.v };
  if (e.type === "click") out.url = e.url;
  if (e.type === "unsubscribe") out.email = e.email;
  if (e.type !== "unsubscribe") out.machine = e.machine;
  out.at = e.at;
  return out;
}

/** Example URLs for the dashboard, with placeholders where the sender fills in values. */
export function exampleUrls(siteBase: string, trackingId: string) {
  const base = `${siteBase.replace(/\/+$/, "")}/t/${trackingId}`;
  return {
    base,
    open: `${base}/o.png?m=MSG_ID&c=CAMPAIGN&v=VARIANT`,
    click: `${base}/c?u=URL_ENCODED_TARGET&m=MSG_ID&c=CAMPAIGN&v=VARIANT&s=SIG_OF_URL`,
    unsubscribe: `${base}/u?m=MSG_ID&c=CAMPAIGN&e=URL_ENCODED_EMAIL&s=SIG_OF_LOWERCASE_EMAIL`,
    events: `${siteBase.replace(/\/+$/, "")}/api/v1/tracking/${trackingId}/events`,
  };
}
