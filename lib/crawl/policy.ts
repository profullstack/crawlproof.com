// Fleet crawler policy (Anthony, 2026-11-08): "crawlers should timeout after
// 10 seconds for fetch, 30 for browser (js, images, css). We don't want broken
// slow shit. Flag to recheck later in a month."
//
// One place for the numbers, so a crawler never grows its own private budget
// again, plus the pure functions that decide what a failure means for the
// next check.
//
// Scope: fetches of THIRD-PARTY urls (pages, feeds, sitemaps, PDFs, og reads)
// and headless renders of third-party pages. NOT in scope, and deliberately
// left on their own fast cadence: uptime monitors (lib/uptime.ts), ad
// link-health (lib/ads/linkHealth.ts), and calls to our own services or
// vendors (Supabase, CoinPay, AI providers, the c0mpute gateway).

/** Total budget for one plain HTTP fetch of a third-party URL: connect + headers + body. */
export const CRAWL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Total budget for a fetch routed through Tor (.onion targets). A Tor circuit
 * alone routinely takes several seconds to build, so the clearnet 10 s would
 * fail healthy onion sites; this is the separate, documented ceiling and it
 * must never exceed the browser budget.
 */
export const TOR_FETCH_TIMEOUT_MS = 30_000;

/** Total navigation budget for a headless-browser render of a third-party page. */
export const CRAWL_BROWSER_TIMEOUT_MS = 30_000;

/**
 * After `load`/`domcontentloaded`, how long a render may wait for late XHR
 * before it reads the page anyway. Bounded: `networkidle` never fires on a
 * page that polls or holds a socket open.
 */
export const CRAWL_BROWSER_SETTLE_MS = 2_000;

/** How long a slow or broken target is left alone before its one recheck. */
export const CRAWL_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** Ceiling on an honoured Retry-After, so a 429 can never park a target longer than a broken one. */
export const RETRY_AFTER_CAP_MS = CRAWL_RECHECK_MS;

/** Budget for one fetch of `url`: Tor gets its own, everything else the crawl budget. */
export function fetchBudgetMs(url: string): number {
  try {
    return /\.onion$/i.test(new URL(url).hostname) ? TOR_FETCH_TIMEOUT_MS : CRAWL_FETCH_TIMEOUT_MS;
  } catch {
    return CRAWL_FETCH_TIMEOUT_MS;
  }
}

/** AbortSignal carrying the crawl budget. Pass it to fetch AND keep it alive while reading the body. */
export function crawlSignal(ms: number = CRAWL_FETCH_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** Thrown by crawlers for a non-2xx response, so the status reaches the classifier. */
export class CrawlHttpError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;
  constructor(status: number, retryAfter: string | null = null, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "CrawlHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type CrawlFailureKind =
  /** timeout, DNS/TLS/connection error, HTTP 5xx: park for CRAWL_RECHECK_MS. */
  | "slow_or_broken"
  /** HTTP 429: honour Retry-After, capped. */
  | "rate_limited"
  /** anything else (4xx, unparseable body, empty feed): the caller's existing semantics. */
  | "other";

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string") return e.code;
  if (e.cause && typeof e.cause === "object") {
    const c = (e.cause as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}

/** Status of a failure: a number for an HTTP response, null for a thrown error. */
export function classifyHttpStatus(status: number): CrawlFailureKind {
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "slow_or_broken";
  return "other";
}

/** What a thrown fetch error (or CrawlHttpError) means for the target. */
export function classifyCrawlError(err: unknown): CrawlFailureKind {
  if (err instanceof CrawlHttpError) return classifyHttpStatus(err.status);
  if (!err || typeof err !== "object") return "other";
  const e = err as { name?: unknown; message?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "";
  // AbortSignal.timeout rejects with TimeoutError; a manual controller.abort() with AbortError.
  if (name === "TimeoutError" || name === "AbortError") return "slow_or_broken";
  const code = errorCode(err);
  if (code && (NETWORK_CODES.has(code) || code.startsWith("ERR_TLS") || code.includes("CERT"))) {
    return "slow_or_broken";
  }
  if ([...NETWORK_CODES].some((c) => message.includes(c))) return "slow_or_broken";
  // undici's catch-all for DNS/TCP/TLS failure, and Node's own abort wording.
  if (/fetch failed|aborted|timed? ?out|socket hang up|getaddrinfo|certificate|ssl|tls/i.test(message)) {
    return "slow_or_broken";
  }
  return "other";
}

/** Parse a Retry-After header (seconds or HTTP date) to milliseconds from `now`, capped. */
export function retryAfterMs(header: string | null | undefined, now: Date): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) ms = at - now.getTime();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS);
}

/** The next time a slow or broken target may be touched: exactly CRAWL_RECHECK_MS out. */
export function crawlRecheckAt(now: Date): Date {
  return new Date(now.getTime() + CRAWL_RECHECK_MS);
}

/**
 * When to look at a failed target next, or null to leave the caller's own
 * schedule in charge (the "other" kind: keep existing 4xx semantics).
 *
 * slow_or_broken -> now + 30 days. rate_limited -> Retry-After (capped at 30
 * days), or null without a usable header so the caller's backoff applies.
 */
export function nextCheckAfterFailure(
  kind: CrawlFailureKind,
  now: Date,
  retryAfter?: string | null,
): Date | null {
  if (kind === "slow_or_broken") return crawlRecheckAt(now);
  if (kind === "rate_limited") {
    const ms = retryAfterMs(retryAfter ?? null, now);
    return ms === null ? null : new Date(now.getTime() + ms);
  }
  return null;
}

/** True once a parked target's 30 days are up and it is owed its one recheck. */
export function recheckDue(lastAttemptAt: string | Date | null | undefined, now: Date): boolean {
  if (!lastAttemptAt) return true;
  const at = typeof lastAttemptAt === "string" ? Date.parse(lastAttemptAt) : lastAttemptAt.getTime();
  if (Number.isNaN(at)) return true;
  return now.getTime() - at >= CRAWL_RECHECK_MS;
}
