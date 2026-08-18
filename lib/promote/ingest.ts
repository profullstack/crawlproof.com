// Promote ingestion: fetch each source feed once, fan the results out to every
// list that subscribes to it.
//
// The fan-out is the point. Two hundred users tracking "bitcoin" all read the
// same RSS Amplifier topic feed, so the registry is keyed on the feed URL and
// polled once per interval; each subscribing list then gets promo_link rows by
// reference. Nothing here is per-user until the fan-out step.
//
// Conditional requests (ETag / Last-Modified) mean an unchanged feed costs a
// 304 rather than a parse, which is most polls of most feeds.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFeed, type ParsedFeedItem } from "@/lib/promote/feedParse";
import { canonicalizeUrl, normalizeUrlForIdentity, urlHash } from "@/lib/promote/normalizeUrl";

const USER_AGENT = "CrawlProofPromote/1.0 (+https://crawlproof.com)";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS_PER_FEED = 50;
const MAX_BODY_BYTES = 5_000_000;

// A failing feed backs off geometrically instead of being polled every 15
// minutes forever. Capped so a feed that comes back is noticed within a day.
const MAX_BACKOFF_MULTIPLIER = 32;
const MAX_BACKOFF_SECONDS = 86_400;

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type IngestResult = {
  feedsChecked: number;
  feedsUnchanged: number;
  feedsFailed: number;
  itemsStored: number;
  linksCreated: number;
};

export type IngestOptions = {
  /** How many due feeds to process in one pass. */
  limit?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests so scheduling maths is deterministic. */
  now?: Date;
};

type FeedRow = {
  id: string;
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
  fetch_interval_seconds: number;
  consecutive_failures: number;
};

type SourceRow = {
  id: string;
  list_id: string;
  ownership: string;
  max_items_per_ingest: number;
  items_imported: number;
};

const emptyResult = (): IngestResult => ({
  feedsChecked: 0,
  feedsUnchanged: 0,
  feedsFailed: 0,
  itemsStored: 0,
  linksCreated: 0,
});

/**
 * Main ingestion entry point, called by the worker on a timer. Claims due
 * feeds, refreshes them, and fans new items out to subscribers.
 */
export async function ingestDueFeeds(
  supabase: SupabaseClient<any>,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const result = emptyResult();

  const { data: feeds, error } = await supabase
    .from("promo_feed")
    .select("id, feed_url, etag, last_modified, fetch_interval_seconds, consecutive_failures")
    .lte("next_fetch_at", now.toISOString())
    .order("next_fetch_at", { ascending: true })
    .limit(options.limit ?? 20);

  if (error || !feeds || feeds.length === 0) return result;

  // Claim every due feed up front by pushing next_fetch_at forward, so an
  // overlapping pass cannot fetch the same feed twice.
  await Promise.all(
    (feeds as FeedRow[]).map((feed) =>
      supabase
        .from("promo_feed")
        .update({ next_fetch_at: nextFetchAt(feed, now, false) })
        .eq("id", feed.id),
    ),
  );

  for (const feed of feeds as FeedRow[]) {
    try {
      const one = await ingestOneFeed(supabase, feed, options, now);
      result.feedsChecked++;
      if (one.unchanged) result.feedsUnchanged++;
      if (one.failed) result.feedsFailed++;
      result.itemsStored += one.itemsStored;
      result.linksCreated += one.linksCreated;
    } catch (err) {
      result.feedsChecked++;
      result.feedsFailed++;
      await recordFailure(supabase, feed, now, err);
    }
  }

  return result;
}

/**
 * Refresh one feed immediately, whatever its schedule says. Used when a user
 * has just added a source and expects to see items without waiting for the
 * next tick.
 */
export async function ingestFeedNow(
  supabase: SupabaseClient<any>,
  feedId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const result = emptyResult();

  const { data: feed } = await supabase
    .from("promo_feed")
    .select("id, feed_url, etag, last_modified, fetch_interval_seconds, consecutive_failures")
    .eq("id", feedId)
    .maybeSingle();
  if (!feed) return result;

  try {
    // A first fetch must not be answered with 304, or a brand new source shows
    // up empty: ignore any stored validators.
    const one = await ingestOneFeed(
      supabase,
      { ...(feed as FeedRow), etag: null, last_modified: null },
      options,
      now,
    );
    result.feedsChecked++;
    if (one.unchanged) result.feedsUnchanged++;
    if (one.failed) result.feedsFailed++;
    result.itemsStored += one.itemsStored;
    result.linksCreated += one.linksCreated;
  } catch (err) {
    result.feedsChecked++;
    result.feedsFailed++;
    await recordFailure(supabase, feed as FeedRow, now, err);
  }

  return result;
}

async function ingestOneFeed(
  supabase: SupabaseClient<any>,
  feed: FeedRow,
  options: IngestOptions,
  now: Date,
): Promise<{ unchanged: boolean; failed: boolean; itemsStored: number; linksCreated: number }> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const headers: Record<string, string> = {
    accept:
      "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5",
    "user-agent": USER_AGENT,
  };
  if (feed.etag) headers["if-none-match"] = feed.etag;
  if (feed.last_modified) headers["if-modified-since"] = feed.last_modified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(feed.feed_url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  // Unchanged since last time: the common case, and the cheap one.
  if (response.status === 304) {
    await supabase
      .from("promo_feed")
      .update({
        last_fetched_at: now.toISOString(),
        last_success_at: now.toISOString(),
        consecutive_failures: 0,
        last_error: null,
        next_fetch_at: nextFetchAt({ ...feed, consecutive_failures: 0 }, now, false),
      })
      .eq("id", feed.id);
    return { unchanged: true, failed: false, itemsStored: 0, linksCreated: 0 };
  }

  if (!response.ok) {
    await recordFailure(supabase, feed, now, new Error(`Feed returned HTTP ${response.status}`));
    return { unchanged: false, failed: true, itemsStored: 0, linksCreated: 0 };
  }

  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) {
    await recordFailure(supabase, feed, now, new Error("Feed body too large"));
    return { unchanged: false, failed: true, itemsStored: 0, linksCreated: 0 };
  }

  const parsed = parseFeed(body, feed.feed_url, MAX_ITEMS_PER_FEED);
  if (parsed.items.length === 0) {
    await recordFailure(supabase, feed, now, new Error("Feed contained no usable entries"));
    return { unchanged: false, failed: true, itemsStored: 0, linksCreated: 0 };
  }

  const rows = parsed.items.map((item) => toItemRow(feed.id, item, now)).filter(isPresent);

  // ignoreDuplicates: a feed re-lists the same entries every poll by design, so
  // a conflict on (feed_id, url_hash) is the normal case, not an error.
  if (rows.length > 0) {
    await supabase
      .from("promo_feed_item")
      .upsert(rows, { onConflict: "feed_id,url_hash", ignoreDuplicates: true });
  }

  await supabase
    .from("promo_feed")
    .update({
      title: parsed.title,
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
      last_fetched_at: now.toISOString(),
      last_success_at: now.toISOString(),
      consecutive_failures: 0,
      last_error: null,
      next_fetch_at: nextFetchAt({ ...feed, consecutive_failures: 0 }, now, false),
    })
    .eq("id", feed.id);

  const linksCreated = await fanOutToSubscribers(supabase, feed.id, now);
  return { unchanged: false, failed: false, itemsStored: rows.length, linksCreated };
}

/**
 * Copy a feed's newest items into every subscribing list as promo_link rows.
 *
 * Exported so a freshly added source can be backfilled without re-fetching the
 * feed it shares with somebody else.
 */
export async function fanOutToSubscribers(
  supabase: SupabaseClient<any>,
  feedId: string,
  now: Date = new Date(),
  onlySourceId?: string,
): Promise<number> {
  let sourceQuery = supabase
    .from("promo_source")
    .select("id, list_id, ownership, max_items_per_ingest, items_imported")
    .eq("feed_id", feedId)
    .eq("enabled", true);
  if (onlySourceId) sourceQuery = sourceQuery.eq("id", onlySourceId);

  const { data: sources } = await sourceQuery;
  if (!sources || sources.length === 0) return 0;

  // Newest first: a list that can only take ten links should take the ten most
  // recent ones, not ten arbitrary ones.
  const widestCap = Math.max(
    ...(sources as SourceRow[]).map((s) => s.max_items_per_ingest ?? 10),
  );
  const { data: items } = await supabase
    .from("promo_feed_item")
    .select(
      "id, url, normalized_url, url_hash, title, summary, image_url, author_name, source_name, published_at",
    )
    .eq("feed_id", feedId)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(Math.min(widestCap, MAX_ITEMS_PER_FEED));

  if (!items || items.length === 0) return 0;

  let created = 0;
  for (const source of sources as SourceRow[]) {
    const slice = items.slice(0, source.max_items_per_ingest ?? 10);
    const linkRows = slice.map((item: any) => ({
      list_id: source.list_id,
      source_id: source.id,
      ownership: source.ownership,
      url: item.url,
      normalized_url: item.normalized_url,
      url_hash: item.url_hash,
      title: item.title,
      summary: item.summary,
      image_url: item.image_url,
      author_name: item.author_name,
      source_name: item.source_name,
      published_at: item.published_at,
      discovered_at: now.toISOString(),
      enabled: true,
    }));

    // The unique index on (list_id, url_hash) does the deduplication: a story
    // this list has already seen is silently skipped, including one that
    // arrived earlier from a different source.
    const { count, error } = await supabase
      .from("promo_link")
      .upsert(linkRows, {
        onConflict: "list_id,url_hash",
        ignoreDuplicates: true,
        count: "exact",
      });

    const added = error ? 0 : (count ?? 0);
    created += added;

    await supabase
      .from("promo_source")
      .update({
        last_ingested_at: now.toISOString(),
        items_imported: (source.items_imported ?? 0) + added,
      })
      .eq("id", source.id);
  }

  return created;
}

function toItemRow(feedId: string, item: ParsedFeedItem, now: Date) {
  const url = canonicalizeUrl(item.url);
  const normalized = normalizeUrlForIdentity(item.url);
  const hash = urlHash(item.url);
  // A feed entry we cannot identify is one we could neither dedupe nor publish.
  if (!url || !normalized || !hash) return null;
  return {
    feed_id: feedId,
    url,
    normalized_url: normalized,
    url_hash: hash,
    title: item.title,
    summary: item.summary,
    image_url: item.imageUrl,
    author_name: item.author,
    source_name: item.sourceName,
    guid: item.guid,
    published_at: item.publishedAt,
    discovered_at: now.toISOString(),
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

async function recordFailure(
  supabase: SupabaseClient<any>,
  feed: FeedRow,
  now: Date,
  err: unknown,
): Promise<void> {
  const failures = (feed.consecutive_failures ?? 0) + 1;
  await supabase
    .from("promo_feed")
    .update({
      last_fetched_at: now.toISOString(),
      consecutive_failures: failures,
      last_error: err instanceof Error ? err.message : String(err),
      next_fetch_at: nextFetchAt({ ...feed, consecutive_failures: failures }, now, true),
    })
    .eq("id", feed.id);
}

/** Geometric backoff while a feed is failing, plain interval while it is healthy. */
export function nextFetchAt(
  feed: Pick<FeedRow, "fetch_interval_seconds" | "consecutive_failures">,
  now: Date,
  failing: boolean,
): string {
  const base = feed.fetch_interval_seconds || 900;
  const failures = failing ? Math.max(1, feed.consecutive_failures ?? 1) : 0;
  const multiplier = Math.min(2 ** Math.max(0, failures - 1), MAX_BACKOFF_MULTIPLIER);
  const seconds = Math.min(base * (failures > 0 ? multiplier : 1), MAX_BACKOFF_SECONDS);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}
