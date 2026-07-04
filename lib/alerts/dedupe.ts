// Canonical-URL normalization for the per-alert dedupe set.
//
// SERP responses give us a URL but not the page's <link rel="canonical">, so
// v1 dedupes on a *normalized* URL, not a true canonical. That means the same
// article syndicated across domains can still produce separate entries — an
// accepted v1 limitation (confirming a real canonical would require crawling
// every result). Within a single domain we collapse the obvious variants:
// scheme, www, default ports, tracking params, fragments, trailing slashes.

const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "li_fat_id",
  "ref",
  "ref_src",
  "source",
  "cmpid",
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAM_NAMES.has(k);
}

/**
 * Normalize a URL into the key we store in alert_seen_urls. http/https and
 * www/non-www are treated as identical; tracking params and fragments are
 * dropped; a trailing slash on a non-root path is removed. Falls back to a
 * lowercased trim for inputs that don't parse as URLs.
 */
export function canonicalizeUrl(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  // Scheme: collapse http/https so the same page over either is one key.
  const scheme = u.protocol === "http:" || u.protocol === "https:" ? "https" : u.protocol.replace(/:$/, "");

  // Host: lowercase, drop a leading www.
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  // Port: drop defaults.
  const port = u.port && !((scheme === "https" || scheme === "http") && (u.port === "80" || u.port === "443")) ? `:${u.port}` : "";

  // Query: drop tracking params, then sort the remainder for stable keys.
  const params = new URLSearchParams(u.search);
  for (const key of Array.from(params.keys())) {
    if (isTrackingParam(key)) params.delete(key);
  }
  params.sort();
  const query = params.toString();

  // Path: strip a trailing slash except for the root.
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");

  return `${scheme}://${host}${port}${path}${query ? `?${query}` : ""}`;
}

/** Bare registrable-ish host for a domain the user typed (strips scheme/www/path). */
export function normalizeDomain(input: string): string {
  if (!input) return "";
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  return s;
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const d = normalizeDomain(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}
