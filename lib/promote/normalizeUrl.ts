// URL canonicalization and identity hashing for Promote content items.
//
// Two different jobs, deliberately kept apart:
//
//   canonicalUrl   what we actually publish. Tracking junk is removed, but the
//                  resource itself is untouched (host case, `www.`, scheme and
//                  trailing slash all preserved) so the link resolves exactly
//                  the way the publisher meant it to.
//
//   normalizedUrl  an identity key used only for dedupe, never published. More
//                  aggressive: scheme folded to https, `www.` dropped, trailing
//                  slash removed, remaining query sorted.
//
// Keeping them apart matters: folding `www.` is right for "have I posted this
// story before?" and wrong for "which URL do I hand to Reddit?".

import { createHash } from "node:crypto";

// Whole families of analytics parameters, matched by prefix.
const TRACKING_PREFIXES = [
  "utm_", // Google/analytics standard
  "pk_", // Matomo (legacy Piwik)
  "mtm_", // Matomo
  "hsa_", // HubSpot ads
  "_hs", // HubSpot email (_hsenc, _hsmi)
  "at_", // AT Internet
  "wt_", // Webtrekk
];

// Individually named click/campaign identifiers.
//
// Deliberately NOT stripped: a bare `ref`. It is a tracking parameter on some
// sites and a routing parameter on others (CrawlProof's own short links use
// `ref_slug`), so removing it can change which page loads. Losing one
// attribution tag is cheaper than publishing a link that 404s.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "_openstat",
  "oly_anon_id",
  "oly_enc_id",
  "ref_src",
  "s_cid",
  "cmpid",
  "vero_id",
  "vero_conv",
  "ck_subscriber_id",
  "hsctatracking",
]);

export function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase();
  if (TRACKING_PARAMS.has(key)) return true;
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function parse(raw: string): URL | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Only ever publish or dedupe web links.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url;
}

function dropTracking(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) url.searchParams.delete(key);
  }
}

/**
 * The publishable form of a URL: tracking parameters removed, fragment
 * dropped, everything else left exactly as the publisher wrote it.
 * Returns null when the input is not a usable http(s) URL.
 */
export function canonicalizeUrl(raw: string): string | null {
  const url = parse(raw);
  if (!url) return null;
  dropTracking(url);
  url.hash = "";
  // A bare "?" left behind after stripping every parameter is noise.
  if ([...url.searchParams.keys()].length === 0) url.search = "";
  return url.toString();
}

/**
 * The dedupe identity of a URL. Not for publishing — this intentionally
 * rewrites the URL into a shape that compares well.
 */
export function normalizeUrlForIdentity(raw: string): string | null {
  const url = parse(raw);
  if (!url) return null;
  dropTracking(url);
  url.hash = "";
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  // Default ports carry no meaning once the scheme is fixed.
  if (url.port === "80" || url.port === "443") url.port = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  if ([...url.searchParams.keys()].length === 0) {
    url.search = "";
  } else {
    url.searchParams.sort();
  }
  return url.toString();
}

/**
 * Stable dedupe key: sha256 of the identity form. Returns null for input that
 * is not a usable http(s) URL, so callers can reject rather than store a hash
 * of garbage.
 */
export function urlHash(raw: string): string | null {
  const identity = normalizeUrlForIdentity(raw);
  if (!identity) return null;
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Titles drift ("Foo — Bar" vs "Foo - Bar"), so same-story detection across
 * different URLs compares a flattened title instead of the raw one.
 */
export function normalizedTitleHash(title: string | null | undefined): string | null {
  const flat = (title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!flat) return null;
  return createHash("sha256").update(flat).digest("hex");
}
