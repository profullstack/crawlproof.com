// The raw linkinator crawl, split out from links-engine.ts so it can run in a
// disposable child process.
//
// Why a child process: linkinator applies its per-link `timeout` as an
// AbortSignal.timeout on the fetch, converts the response body with
// Readable.fromWeb(), then pipes it to the HTML parser with the 'error' handler
// attached to the *destination* (build/src/links.js:158). pipe() does not
// forward source errors, so when the abort fires mid-body the source Readable
// emits an unhandled 'error' event and Node hard-exits the process. That is not
// catchable from linksAudit()'s try/catch, and because start.sh runs the worker
// and Next.js under `wait -n`, it took the whole container down with every
// in-flight audit. Run it somewhere we can afford to lose.
//
// Crawl bounds live here too: linkinator has no built-in page cap or
// AbortSignal, so we bound the crawl with its `linksToSkip` extension point.
// Once we exceed a page / link / wall-clock budget the predicate returns true
// for every remaining link, which stops both checking and recursion. This keeps
// a runaway crawl well under the worker's 7-minute stuck-audit cutoff.

import { LinkChecker, LinkState } from "linkinator";

const UA = "CrawlProofBot/1.0 (+https://crawlproof.com/bot)";

// Budgets — generous enough for a typical CrawlProof property, hard-capped so
// the worker can't blow past the 7-minute stuck-sweep cutoff.
export const MAX_PAGES = 250; // distinct internal pages we recurse into
export const MAX_LINKS = 5000; // total links checked (internal + external)
export const DEADLINE_MS = 4 * 60 * 1000; // wall-clock crawl budget
export const PER_LINK_TIMEOUT_MS = 10_000;
const CONCURRENCY = 25;

export type Capped = null | "pages" | "links" | "time";

/** A linkinator LinkResult, reduced to what survives JSON round-tripping. */
export type CrawlLink = {
  url: string;
  status: number;
  state: string;
  parent: string | null;
};

/**
 * Filled in as the crawl runs rather than read off the resolved return value,
 * so a crash partway through still leaves usable results behind.
 */
export type CrawlAccumulator = {
  pagesCrawled: number;
  capped: Capped;
  links: CrawlLink[];
};

export function newAccumulator(): CrawlAccumulator {
  return { pagesCrawled: 0, capped: null, links: [] };
}

export function rootOf(targetUrl: string): string {
  // Crawl from the root domain, not the submitted deep link — the user asked
  // the bot to sweep the whole property, not just one page.
  const u = new URL(targetUrl);
  return `${u.protocol}//${u.host}/`;
}

export async function crawlLinks(
  targetUrl: string,
  acc: CrawlAccumulator,
  opts: { perLinkTimeoutMs?: number } = {},
): Promise<void> {
  const started = Date.now();
  const root = rootOf(targetUrl);
  const checker = new LinkChecker();

  checker.on("pagestart", () => {
    acc.pagesCrawled++;
  });

  // Accumulate incrementally — `check()`'s return value is unreachable if the
  // crawl dies partway through.
  checker.on("link", (link: { url: string; status?: number; state: string; parent?: string }) => {
    acc.links.push({
      url: link.url,
      status: link.status ?? 0,
      state: link.state,
      parent: link.parent ?? null,
    });
  });

  // Doubles as the crawl's kill-switch: returning true marks a link SKIPPED,
  // which also prevents linkinator from recursing into it.
  const linksToSkip = async (link: string): Promise<boolean> => {
    // linkinator already skips non-http(s) schemes, but guard anyway.
    if (!/^https?:\/\//i.test(link)) return true;
    if (Date.now() - started > DEADLINE_MS) {
      acc.capped ??= "time";
      return true;
    }
    if (acc.pagesCrawled >= MAX_PAGES) {
      acc.capped ??= "pages";
      return true;
    }
    if (checkedCount(acc) >= MAX_LINKS) {
      acc.capped ??= "links";
      return true;
    }
    return false;
  };

  await checker.check({
    path: root,
    recurse: true,
    concurrency: CONCURRENCY,
    timeout: opts.perLinkTimeoutMs ?? PER_LINK_TIMEOUT_MS,
    userAgent: UA,
    retry: true,
    linksToSkip,
  });
}

/** Links we actually hit the network for (SKIPPED ones were never fetched). */
export function checkedCount(acc: CrawlAccumulator): number {
  return acc.links.filter((l) => l.state !== LinkState.SKIPPED).length;
}
