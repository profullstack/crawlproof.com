// Fleet crawler policy: 10 s per fetch, 30 s per browser render, and a slow or
// broken target is flagged and left alone for 30 days, then rechecked once.
import { describe, expect, it } from "vitest";
import {
  CRAWL_BROWSER_SETTLE_MS,
  CRAWL_BROWSER_TIMEOUT_MS,
  CRAWL_FETCH_TIMEOUT_MS,
  CRAWL_RECHECK_MS,
  CrawlHttpError,
  RETRY_AFTER_CAP_MS,
  TOR_FETCH_TIMEOUT_MS,
  classifyCrawlError,
  classifyHttpStatus,
  crawlRecheckAt,
  fetchBudgetMs,
  nextCheckAfterFailure,
  recheckDue,
  retryAfterMs,
} from "@/lib/crawl/policy";
import { failureNextFetchAt } from "@/lib/promote/ingest";
import { feedFailureNextCheck } from "@/lib/sp/feedAutopost";
import { claimDueSitemapRechecks, sitemapFailureFields, sitemapSuccessFields } from "@/lib/lx/sitemapCrawl";
import { crawlFeeds, GIVEN_UP_RECHECK_MS } from "@/lib/lx/feedCrawl";
import { makeFakeSupabase } from "./promote/fake-supabase";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("budgets", () => {
  it("is 10 s per fetch, 30 s per render, settle <= 2 s, 30 days to recheck", () => {
    expect(CRAWL_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(CRAWL_BROWSER_TIMEOUT_MS).toBe(30_000);
    expect(CRAWL_BROWSER_SETTLE_MS).toBeLessThanOrEqual(2_000);
    expect(CRAWL_RECHECK_MS).toBe(30 * DAY);
  });

  it("gives Tor its own budget, never above 30 s", () => {
    expect(TOR_FETCH_TIMEOUT_MS).toBeGreaterThan(CRAWL_FETCH_TIMEOUT_MS);
    expect(TOR_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(fetchBudgetMs("http://expyuzz4wqqyqhjn.onion/")).toBe(TOR_FETCH_TIMEOUT_MS);
    expect(fetchBudgetMs("https://example.com/")).toBe(CRAWL_FETCH_TIMEOUT_MS);
    expect(fetchBudgetMs("not a url")).toBe(CRAWL_FETCH_TIMEOUT_MS);
  });
});

describe("classify", () => {
  it("treats 5xx as broken, 429 as rate limited, other 4xx as the caller's business", () => {
    expect(classifyHttpStatus(500)).toBe("slow_or_broken");
    expect(classifyHttpStatus(503)).toBe("slow_or_broken");
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(404)).toBe("other");
    expect(classifyHttpStatus(403)).toBe("other");
  });

  it("treats timeouts and network failures as slow or broken", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyCrawlError(timeout)).toBe("slow_or_broken");
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(classifyCrawlError(abort)).toBe("slow_or_broken");
    expect(classifyCrawlError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(
      "slow_or_broken",
    );
    expect(classifyCrawlError(new Error("ECONNRESET"))).toBe("slow_or_broken");
    expect(classifyCrawlError({ code: "CERT_HAS_EXPIRED", message: "certificate has expired" })).toBe(
      "slow_or_broken",
    );
    expect(classifyCrawlError(new CrawlHttpError(502))).toBe("slow_or_broken");
  });

  it("leaves content problems alone", () => {
    expect(classifyCrawlError(new Error("Feed contained no usable entries"))).toBe("other");
    expect(classifyCrawlError(new CrawlHttpError(404))).toBe("other");
    expect(classifyCrawlError(null)).toBe("other");
  });
});

describe("next check", () => {
  it("parks a slow or broken target for exactly 30 days", () => {
    expect(crawlRecheckAt(NOW).getTime() - NOW.getTime()).toBe(30 * DAY);
    expect(nextCheckAfterFailure("slow_or_broken", NOW)?.toISOString()).toBe("2026-12-08T12:00:00.000Z");
  });

  it("honours Retry-After on a 429 but caps it at 30 days", () => {
    expect(retryAfterMs("120", NOW)).toBe(120_000);
    expect(retryAfterMs("Sun, 08 Nov 2026 13:00:00 GMT", NOW)).toBe(3_600_000);
    expect(retryAfterMs(String(365 * 86_400), NOW)).toBe(RETRY_AFTER_CAP_MS);
    expect(retryAfterMs("garbage", NOW)).toBeNull();
    expect(nextCheckAfterFailure("rate_limited", NOW, "60")?.getTime()).toBe(NOW.getTime() + 60_000);
    expect(nextCheckAfterFailure("rate_limited", NOW, null)).toBeNull();
  });

  it("leaves other failures on the caller's schedule", () => {
    expect(nextCheckAfterFailure("other", NOW)).toBeNull();
  });

  it("owes a recheck once 30 days have passed, not before", () => {
    expect(recheckDue(new Date(NOW.getTime() - 29 * DAY), NOW)).toBe(false);
    expect(recheckDue(new Date(NOW.getTime() - 30 * DAY), NOW)).toBe(true);
    expect(recheckDue(null, NOW)).toBe(true);
  });
});

describe("promote feeds", () => {
  const feed = { fetch_interval_seconds: 900, consecutive_failures: 0 };

  it("parks a timed-out or 5xx feed for 30 days instead of a geometric retry", () => {
    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(failureNextFetchAt(feed, NOW, timeout)).toBe("2026-12-08T12:00:00.000Z");
    expect(failureNextFetchAt(feed, NOW, new CrawlHttpError(503))).toBe("2026-12-08T12:00:00.000Z");
  });

  it("keeps the backoff for a 404, until it has failed long enough to park", () => {
    expect(failureNextFetchAt(feed, NOW, new CrawlHttpError(404))).toBe("2026-11-08T12:15:00.000Z");
    expect(failureNextFetchAt({ ...feed, consecutive_failures: 7 }, NOW, new CrawlHttpError(404))).toBe(
      "2026-12-08T12:00:00.000Z",
    );
  });

  it("follows Retry-After on a 429", () => {
    expect(failureNextFetchAt(feed, NOW, new CrawlHttpError(429, "3600"))).toBe("2026-11-08T13:00:00.000Z");
  });
});

describe("social feed autopost", () => {
  it("parks an unreachable feed for 30 days, a 4xx for a day, our own errors not at all", () => {
    const timeout = Object.assign(new Error("Feed timed out after 10s"), { name: "TimeoutError" });
    expect(feedFailureNextCheck(timeout, NOW)?.toISOString()).toBe("2026-12-08T12:00:00.000Z");
    expect(feedFailureNextCheck(new CrawlHttpError(500), NOW)?.toISOString()).toBe("2026-12-08T12:00:00.000Z");
    expect(feedFailureNextCheck(new CrawlHttpError(404), NOW)?.toISOString()).toBe("2026-11-09T12:00:00.000Z");
    expect(feedFailureNextCheck(new Error("Project not found."), NOW)).toBeNull();
  });
});

describe("sitemaps", () => {
  it("flags a failed crawl with a recheck 30 days out and clears it on success", () => {
    const failed = sitemapFailureFields("error: timed out after 10s", NOW);
    expect(failed.sitemap_next_check_at).toBe("2026-12-08T12:00:00.000Z");
    expect(failed.sitemap_failed_at).toBe(NOW.toISOString());
    const ok = sitemapSuccessFields("ok (3 pages)", NOW);
    expect(ok.sitemap_next_check_at).toBeNull();
    expect(ok.sitemap_failed_at).toBeNull();
  });

  it("claims only sites whose recheck is due, and pushes the claim forward", async () => {
    const { client, db } = makeFakeSupabase({
      lx_site: [
        { id: "due", sitemap_next_check_at: "2026-11-01T00:00:00.000Z" },
        { id: "later", sitemap_next_check_at: "2026-12-01T00:00:00.000Z" },
        { id: "healthy", sitemap_next_check_at: null },
      ],
    });
    const ids = await claimDueSitemapRechecks(client, NOW);
    expect(ids).toEqual(["due"]);
    const due = db.lx_site.find((r) => r.id === "due")!;
    expect(Date.parse(due.sitemap_next_check_at)).toBeGreaterThan(NOW.getTime());
  });
});

describe("lx feed sources", () => {
  it("gives a parked source its one recheck after 30 days and reactivates it on success", async () => {
    expect(GIVEN_UP_RECHECK_MS).toBe(30 * DAY);
    const updates: Array<Record<string, unknown>> = [];
    const parked = { id: "src-1", topic: "seo", url: "https://rssamplifier.com/topics/seo.rss", consecutive_failures: 8 };
    const filtersSeen: string[] = [];
    const supabase = {
      from(table: string) {
        const state: { op: string; status?: string; payload?: Record<string, unknown> } = { op: "select" };
        const b: any = {
          select: () => b,
          eq: (col: string, v: string) => {
            if (col === "status") state.status = v;
            return b;
          },
          or: () => b,
          lt: (col: string, v: string) => {
            filtersSeen.push(`${col}<${v}`);
            return b;
          },
          order: () => b,
          limit: () => b,
          not: () => b,
          delete: () => {
            state.op = "delete";
            return b;
          },
          upsert: () => b,
          update: (p: Record<string, unknown>) => {
            state.op = "update";
            state.payload = p;
            updates.push(p);
            return b;
          },
          then: (res: (v: unknown) => unknown) => {
            if (table === "lx_feed_source" && state.op === "select" && state.status === "given_up") {
              return Promise.resolve({ data: [parked], error: null }).then(res);
            }
            return Promise.resolve({ data: [], error: null }).then(res);
          },
        };
        return b;
      },
    };
    const feed = `<rss><channel><item><title>How small blogs win search traffic in 2026</title><link>https://blog.example/a</link></item></channel></rss>`;
    const fetchImpl = (async () => new Response(feed, { status: 200 })) as typeof fetch;

    const result = await crawlFeeds(supabase as any, fetchImpl);

    expect(result.fetched).toBe(1);
    expect(result.succeeded).toBe(1);
    const cutoff = filtersSeen.find((f) => f.startsWith("last_fetch_at<"));
    expect(cutoff).toBeDefined();
    expect(Date.now() - Date.parse(cutoff!.split("<")[1])).toBeGreaterThanOrEqual(30 * DAY - 60_000);
    const last = updates.at(-1)!;
    expect(last.status).toBe("active");
    expect(last.consecutive_failures).toBe(0);
  });
});
