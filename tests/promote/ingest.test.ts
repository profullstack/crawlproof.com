import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestDueFeeds, nextFetchAt, type FetchLike } from "@/lib/promote/ingest";
import { makeFakeSupabase, resetIds, type FakeDb } from "./fake-supabase";

const bitcoinFeed = readFileSync(
  join(__dirname, "fixtures", "rssamplifier-bitcoin.rss"),
  "utf8",
);

const NOW = new Date("2026-08-18T12:00:00.000Z");

// Unique constraints the real schema enforces, and that the fan-out relies on.
const CONSTRAINTS = [
  { table: "promo_feed_item", columns: ["feed_id", "url_hash"] },
  { table: "promo_link", columns: ["list_id", "url_hash"] },
];

function response(body: string, init?: { status?: number; headers?: Record<string, string> }) {
  const headers = init?.headers ?? {};
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function seed(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    promo_feed: [
      {
        id: "feed-bitcoin",
        feed_url: "https://rssamplifier.com/topics/bitcoin.rss",
        kind: "rssamplifier_topic",
        etag: null,
        last_modified: null,
        fetch_interval_seconds: 900,
        consecutive_failures: 0,
        next_fetch_at: "2026-08-18T11:00:00.000Z",
      },
    ],
    promo_feed_item: [],
    promo_source: [
      {
        id: "source-a",
        list_id: "list-a",
        feed_id: "feed-bitcoin",
        ownership: "shared",
        enabled: true,
        max_items_per_ingest: 10,
        items_imported: 0,
      },
    ],
    promo_link: [],
    ...overrides,
  };
}

beforeEach(() => resetIds());

describe("ingestDueFeeds", () => {
  it("fetches a due feed, stores its items and fans them out", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response(bitcoinFeed, { headers: { etag: 'W/"abc"' } });

    const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(result.feedsChecked).toBe(1);
    expect(result.feedsFailed).toBe(0);
    expect(result.itemsStored).toBe(4);
    expect(result.linksCreated).toBe(4);
    expect(db.promo_feed_item).toHaveLength(4);
    expect(db.promo_link).toHaveLength(4);
  });

  it("stamps imported links with the subscription's ownership and provenance", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response(bitcoinFeed);

    await ingestDueFeeds(client, { fetchImpl, now: NOW });

    const link = db.promo_link[0];
    expect(link.list_id).toBe("list-a");
    expect(link.source_id).toBe("source-a");
    expect(link.ownership).toBe("shared");
    expect(link.url_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(link.enabled).toBe(true);
    // Attribution survives the trip, so shared content can be credited.
    expect(link.source_name).toBeTruthy();
  });

  it("stores the validators it was given, so the next poll is conditional", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () =>
      response(bitcoinFeed, {
        headers: { etag: 'W/"abc"', "last-modified": "Mon, 17 Aug 2026 22:27:24 GMT" },
      });

    await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(db.promo_feed[0].etag).toBe('W/"abc"');
    expect(db.promo_feed[0].last_modified).toBe("Mon, 17 Aug 2026 22:27:24 GMT");
  });

  it("sends the stored validators back on the next poll", async () => {
    const withEtag = seed();
    withEtag.promo_feed[0].etag = 'W/"abc"';
    withEtag.promo_feed[0].last_modified = "Mon, 17 Aug 2026 22:27:24 GMT";
    const { client } = makeFakeSupabase(withEtag, CONSTRAINTS);

    const sent: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      sent.push(init?.headers ?? {});
      return response("", { status: 304 });
    };

    await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(sent[0]["if-none-match"]).toBe('W/"abc"');
    expect(sent[0]["if-modified-since"]).toBe("Mon, 17 Aug 2026 22:27:24 GMT");
  });

  it("treats 304 as success and does no work", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response("", { status: 304 });

    const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(result.feedsUnchanged).toBe(1);
    expect(result.feedsFailed).toBe(0);
    expect(result.itemsStored).toBe(0);
    expect(db.promo_link).toHaveLength(0);
    expect(db.promo_feed[0].last_success_at).toBe(NOW.toISOString());
  });

  it("does not import the same story twice across polls", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response(bitcoinFeed);

    await ingestDueFeeds(client, { fetchImpl, now: NOW });
    // Feeds re-list the same entries every poll; make the feed due again.
    db.promo_feed[0].next_fetch_at = "2026-08-18T11:00:00.000Z";
    const second = await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(second.linksCreated).toBe(0);
    expect(db.promo_link).toHaveLength(4);
    expect(db.promo_feed_item).toHaveLength(4);
  });

  it("fetches once and fans out to every subscribing list", async () => {
    const twoLists = seed();
    twoLists.promo_source.push({
      id: "source-b",
      list_id: "list-b",
      feed_id: "feed-bitcoin",
      ownership: "shared",
      enabled: true,
      max_items_per_ingest: 10,
      items_imported: 0,
    });
    const { client, db } = makeFakeSupabase(twoLists, CONSTRAINTS);

    let fetches = 0;
    const fetchImpl: FetchLike = async () => {
      fetches++;
      return response(bitcoinFeed);
    };

    const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

    // The whole point of the shared registry.
    expect(fetches).toBe(1);
    expect(result.linksCreated).toBe(8);
    expect(db.promo_link.filter((l) => l.list_id === "list-a")).toHaveLength(4);
    expect(db.promo_link.filter((l) => l.list_id === "list-b")).toHaveLength(4);
  });

  it("skips disabled subscriptions", async () => {
    const paused = seed();
    paused.promo_source[0].enabled = false;
    const { client, db } = makeFakeSupabase(paused, CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response(bitcoinFeed);

    const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(result.itemsStored).toBe(4);
    expect(result.linksCreated).toBe(0);
    expect(db.promo_link).toHaveLength(0);
  });

  it("honours a source's per-ingest cap", async () => {
    const capped = seed();
    capped.promo_source[0].max_items_per_ingest = 2;
    const { client, db } = makeFakeSupabase(capped, CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response(bitcoinFeed);

    await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(db.promo_link).toHaveLength(2);
  });

  it("records the running import count on the source", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () => response(bitcoinFeed);

    await ingestDueFeeds(client, { fetchImpl, now: NOW });

    expect(db.promo_source[0].items_imported).toBe(4);
    expect(db.promo_source[0].last_ingested_at).toBe(NOW.toISOString());
  });

  it("leaves a feed that is not due yet alone", async () => {
    const notDue = seed();
    notDue.promo_feed[0].next_fetch_at = "2026-08-18T13:00:00.000Z";
    const { client } = makeFakeSupabase(notDue, CONSTRAINTS);

    let fetches = 0;
    const fetchImpl: FetchLike = async () => {
      fetches++;
      return response(bitcoinFeed);
    };

    const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });
    expect(result.feedsChecked).toBe(0);
    expect(fetches).toBe(0);
  });

  it("claims a feed before fetching, so an overlapping pass cannot double-fetch", async () => {
    const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
    const fetchImpl: FetchLike = async () => {
      // Mid-fetch, the row must already be pushed past `now`.
      expect(new Date(db.promo_feed[0].next_fetch_at).getTime()).toBeGreaterThan(
        NOW.getTime(),
      );
      return response(bitcoinFeed);
    };
    await ingestDueFeeds(client, { fetchImpl, now: NOW });
  });

  describe("failure handling", () => {
    it("records an HTTP error and backs the feed off", async () => {
      const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
      const fetchImpl: FetchLike = async () => response("nope", { status: 500 });

      const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

      expect(result.feedsFailed).toBe(1);
      expect(db.promo_feed[0].consecutive_failures).toBe(1);
      expect(db.promo_feed[0].last_error).toContain("500");
    });

    it("treats a page that is not a feed as a failure", async () => {
      const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
      const fetchImpl: FetchLike = async () => response("<html><body>hi</body></html>");

      const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

      expect(result.feedsFailed).toBe(1);
      expect(db.promo_feed[0].last_error).toContain("no usable entries");
    });

    it("survives a thrown fetch without losing the pass", async () => {
      const { client, db } = makeFakeSupabase(seed(), CONSTRAINTS);
      const fetchImpl: FetchLike = async () => {
        throw new Error("ECONNRESET");
      };

      const result = await ingestDueFeeds(client, { fetchImpl, now: NOW });

      expect(result.feedsFailed).toBe(1);
      expect(db.promo_feed[0].last_error).toBe("ECONNRESET");
    });
  });
});

describe("nextFetchAt", () => {
  const feed = { fetch_interval_seconds: 900, consecutive_failures: 0 };

  it("uses the plain interval while healthy", () => {
    expect(nextFetchAt(feed, NOW, false)).toBe("2026-08-18T12:15:00.000Z");
  });

  it("backs off geometrically while failing", () => {
    expect(nextFetchAt({ ...feed, consecutive_failures: 1 }, NOW, true)).toBe(
      "2026-08-18T12:15:00.000Z",
    );
    expect(nextFetchAt({ ...feed, consecutive_failures: 3 }, NOW, true)).toBe(
      "2026-08-18T13:00:00.000Z",
    );
  });

  it("caps the backoff at a day, so a recovered feed is noticed", () => {
    const far = nextFetchAt({ ...feed, consecutive_failures: 99 }, NOW, true);
    expect(new Date(far).getTime() - NOW.getTime()).toBeLessThanOrEqual(86_400_000);
  });
});
