// The daemon side of the directory feeds.
//
// `postsFromTopicFeeds` used to fetch RSS live, inside article delivery, on a
// three-second budget. That is a third-party HTTP call on the critical path of
// the one operation a customer pays for, and it made the source invisible: a
// topic feed going missing showed up as an empty block and nothing else.
//
// This moves the fetching onto the worker's own schedule and leaves a record
// of every attempt. Delivery then reads rows. The two halves fail
// independently — a dead directory ages the cache instead of slowing down a
// publish, and a publish never waits on anybody else's server.
//
// The source list is derived on every sweep from the master_keywords of every
// active site. Nobody maintains it. A blog that adds a subject has that
// subject's feed crawled on the next tick, which is the behaviour "no human
// intervention" actually requires — a curated feed list is a queue of requests
// waiting for somebody.

import type { SupabaseClient } from "@supabase/supabase-js";
import { itemEntries } from "./feedTopics";
import { resolveMasters, tokens } from "./topicPlan";

const RSSAMPLIFIER = "https://rssamplifier.com";

/** Per-feed budget. Generous next to delivery's, because nothing waits on it. */
const FETCH_TIMEOUT_MS = 12_000;

/** Feeds read per sweep. Bounded so one tick cannot run for an hour. */
const PER_SWEEP = 25;

/** Don't re-read a feed more often than this. */
export const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Consecutive failures before a source is parked.
 *
 * Parked, not deleted. A deleted row is re-derived on the very next sweep from
 * the same master keyword and starts failing again immediately — an infinite
 * retry wearing the costume of a clean table. The row stays so the status page
 * can say "this topic has no feed, here is why".
 */
const GIVE_UP_AFTER = 8;

/** Items kept per source. Older ones are pruned so the table stays bounded. */
const KEEP_PER_SOURCE = 40;

/**
 * The directory's slug for a subject.
 *
 * Mirrors `topicSlug` in feedTopics but drops the stopword-free tokenisation
 * through `tokens` first, so a master keyword of "merchant account payments"
 * slugs to something the directory actually has a topic for rather than a long
 * phrase that will always 404.
 */
export function topicFor(master: string): string | null {
  const parts = tokens(master);
  if (parts.length === 0) {
    // A short subject ("iptv", "weed") has no tokens over the length floor but
    // is still a real topic — fall back to the raw slug rather than dropping
    // exactly the short, high-value subjects.
    const raw = (master ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return raw || null;
  }
  return parts[0];
}

export type FeedSweepResult = {
  sources: number;
  fetched: number;
  succeeded: number;
  newItems: number;
  gaveUp: number;
};

/**
 * Make sure every subject any active site covers has a source row.
 *
 * Insert-only, ignoring conflicts: a topic already present keeps its history,
 * and two sites sharing a subject share one crawl.
 */
export async function syncFeedSources(
  supabase: SupabaseClient<any>,
): Promise<number> {
  const { data: sites } = await supabase
    .from("lx_site")
    .select("master_keywords, seed_keywords")
    .eq("status", "active");

  const topics = new Set<string>();
  for (const site of (sites ?? []) as Array<{
    master_keywords: string[] | null;
    seed_keywords: string[] | null;
  }>) {
    for (const master of resolveMasters(site)) {
      const topic = topicFor(master);
      if (topic) topics.add(topic);
    }
  }
  if (topics.size === 0) return 0;

  const rows = Array.from(topics).map((topic) => ({
    topic,
    url: `${RSSAMPLIFIER}/topics/${encodeURIComponent(topic)}.rss`,
  }));

  const { error } = await supabase
    .from("lx_feed_source")
    .upsert(rows, { onConflict: "topic", ignoreDuplicates: true });
  if (error) console.warn("[lx] feed source sync:", error.message);

  return topics.size;
}

/**
 * Read the feeds that are due.
 *
 * Least-recently-fetched first, capped, so the sweep is a fixed amount of work
 * regardless of how many subjects the platform covers.
 */
export async function crawlFeeds(
  supabase: SupabaseClient<any>,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedSweepResult> {
  const sources = await syncFeedSources(supabase);
  const due = new Date(Date.now() - REFRESH_AFTER_MS).toISOString();

  const { data: batch } = await supabase
    .from("lx_feed_source")
    .select("id, topic, url, consecutive_failures")
    .eq("status", "active")
    .or(`last_fetch_at.is.null,last_fetch_at.lt.${due}`)
    .order("last_fetch_at", { ascending: true, nullsFirst: true })
    .limit(PER_SWEEP);

  const result: FeedSweepResult = {
    sources,
    fetched: 0,
    succeeded: 0,
    newItems: 0,
    gaveUp: 0,
  };

  for (const source of (batch ?? []) as Array<{
    id: string;
    topic: string;
    url: string;
    consecutive_failures: number;
  }>) {
    result.fetched += 1;
    const now = new Date().toISOString();

    let status: number | null = null;
    let entries: Array<{ title: string; link: string | null }> = [];
    let error: string | null = null;

    try {
      const res = await fetchImpl(source.url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/rss+xml, application/xml;q=0.9" },
      });
      status = res.status;
      if (res.ok) {
        entries = itemEntries(await res.text()).filter((e) => e.link);
      } else {
        error = `HTTP ${res.status}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // A 200 carrying no items is not a success. It is what the directory
    // returns for a topic nobody publishes under, and counting it as one
    // would let a permanently empty topic sit at the front of the
    // least-recently-fetched queue for ever, crowding out real feeds.
    const ok = error === null && entries.length > 0;
    if (!ok && !error) error = "no usable items";

    if (ok) {
      result.succeeded += 1;
      const rows = entries.slice(0, KEEP_PER_SOURCE).map((e) => ({
        source_id: source.id,
        title: e.title,
        link: e.link as string,
      }));
      const { data: inserted } = await supabase
        .from("lx_feed_item")
        .upsert(rows, { onConflict: "source_id,link", ignoreDuplicates: true })
        .select("id");
      result.newItems += inserted?.length ?? 0;
      await pruneItems(supabase, source.id);
    }

    const failures = ok ? 0 : source.consecutive_failures + 1;
    const givingUp = failures >= GIVE_UP_AFTER;
    if (givingUp) result.gaveUp += 1;

    await supabase
      .from("lx_feed_source")
      .update({
        last_fetch_at: now,
        ...(ok ? { last_success_at: now, item_count: entries.length } : {}),
        last_status: status,
        last_error: ok ? null : error,
        consecutive_failures: failures,
        status: givingUp ? "given_up" : "active",
        updated_at: now,
      })
      .eq("id", source.id);
  }

  return result;
}

/** Keep the newest KEEP_PER_SOURCE items and drop the rest. */
async function pruneItems(supabase: SupabaseClient<any>, sourceId: string): Promise<void> {
  const { data: keep } = await supabase
    .from("lx_feed_item")
    .select("id")
    .eq("source_id", sourceId)
    .order("first_seen_at", { ascending: false })
    .limit(KEEP_PER_SOURCE);
  const ids = (keep ?? []).map((r: { id: string }) => r.id);
  if (ids.length < KEEP_PER_SOURCE) return;
  await supabase
    .from("lx_feed_item")
    .delete()
    .eq("source_id", sourceId)
    .not("id", "in", `(${ids.join(",")})`);
}

/**
 * Cached posts for a set of subjects.
 *
 * The read side of the crawl, used by article delivery. Returns nothing rather
 * than falling back to a live fetch: a cache miss here means the sweep has not
 * reached that topic yet, and the correct behaviour is an article without a
 * citation block, not a publish that blocks on somebody else's server. The
 * next article gets the block.
 */
export async function cachedFeedPosts(
  supabase: SupabaseClient<any>,
  masters: string[],
  limit = 3,
): Promise<Array<{ title: string; link: string; topic: string }>> {
  const topics = Array.from(
    new Set(masters.map(topicFor).filter((t): t is string => !!t)),
  );
  if (topics.length === 0) return [];

  const { data } = await supabase
    .from("lx_feed_item")
    .select("title, link, source:lx_feed_source!inner(topic)")
    .in("source.topic", topics)
    .order("first_seen_at", { ascending: false })
    .limit(limit * 12);

  type Row = { title: string; link: string; source: { topic: string } | { topic: string }[] };
  const byTopic = new Map<string, Array<{ title: string; link: string; topic: string }>>();
  for (const row of (data ?? []) as Row[]) {
    const source = Array.isArray(row.source) ? row.source[0] : row.source;
    const topic = source?.topic;
    if (!topic) continue;
    const bucket = byTopic.get(topic) ?? [];
    bucket.push({ title: row.title, link: row.link, topic });
    byTopic.set(topic, bucket);
  }

  // One per topic before a second from any, so three citations show three
  // subjects rather than three posts from whichever feed is busiest.
  const out: Array<{ title: string; link: string; topic: string }> = [];
  const queues = Array.from(byTopic.values());
  let live = true;
  while (live && out.length < limit) {
    live = false;
    for (const queue of queues) {
      if (out.length >= limit) break;
      const next = queue.shift();
      if (next) {
        out.push(next);
        live = true;
      }
    }
  }
  return out;
}
