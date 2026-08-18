// Creating and validating Promote content sources.
//
// The shared registry is what makes this cheap at scale: adding "bitcoin" to a
// list does not create a feed, it *joins* one. The second user to track
// bitcoin reuses the first user's promo_feed row and starts from the items it
// has already collected.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseFeed } from "@/lib/promote/feedParse";
import { topicFeedUrl, type KeywordInput } from "@/lib/promote/keywords";
import type { FetchLike } from "@/lib/promote/ingest";

// Same guard the audit engine applies to user-supplied targets: a feed URL is
// fetched by our server, so it must not be able to point at our own network.
// Wider than the audit copy — it also covers the 172.16/12 private range.
const PRIVATE_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc00:|fd00:|.*\.local)$/i;

const VALIDATE_TIMEOUT_MS = 15_000;

export type FeedKind = "rssamplifier_topic" | "custom_feed" | "project_feed";

export type SourceValidation =
  | { ok: true; feedUrl: string; title: string | null; itemCount: number }
  | { ok: false; error: string };

/**
 * Normalize a user-supplied feed URL, or explain why it is unusable.
 * Bare hostnames are accepted and assumed https, the way users paste them.
 */
export function normalizeFeedUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Enter a feed URL." };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https feeds are supported." };
  }
  if (PRIVATE_HOSTS.test(url.hostname)) {
    return { ok: false, error: "That address is not reachable from the public internet." };
  }
  url.hash = "";
  return { ok: true, url: url.toString() };
}

/**
 * Fetch a candidate feed and confirm it parses into entries.
 *
 * Adding a source that turns out to be an HTML page is a mistake worth
 * catching while the user is still looking at the form, rather than leaving
 * them to wonder why a campaign never posts.
 */
export async function validateFeedUrl(
  raw: string,
  fetchImpl?: FetchLike,
): Promise<SourceValidation> {
  const normalized = normalizeFeedUrl(raw);
  if (!normalized.ok) return normalized;

  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const response = await doFetch(normalized.url, {
      headers: {
        accept:
          "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5",
        "user-agent": "CrawlProofPromote/1.0 (+https://crawlproof.com)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error:
          response.status === 404
            ? "No feed at that address (404)."
            : `That address returned HTTP ${response.status}.`,
      };
    }
    const body = await response.text();
    const parsed = parseFeed(body, normalized.url);
    if (parsed.items.length === 0) {
      return { ok: false, error: "That address is reachable but is not an RSS or Atom feed." };
    }
    return {
      ok: true,
      feedUrl: normalized.url,
      title: parsed.title,
      itemCount: parsed.items.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message.includes("abort") ? "That feed took too long to respond." : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find or create the shared registry row for a feed URL. Concurrent callers
 * are safe: feed_url is unique, so a lost race re-reads the winner's row.
 */
export async function ensureFeed(
  supabase: SupabaseClient<any>,
  input: { feedUrl: string; kind: FeedKind; topicSlug?: string | null; title?: string | null },
): Promise<{ id: string; created: boolean } | null> {
  const { data: existing } = await supabase
    .from("promo_feed")
    .select("id")
    .eq("feed_url", input.feedUrl)
    .maybeSingle();
  if (existing) return { id: existing.id as string, created: false };

  const { data: inserted, error } = await supabase
    .from("promo_feed")
    .insert({
      feed_url: input.feedUrl,
      kind: input.kind,
      topic_slug: input.topicSlug ?? null,
      title: input.title ?? null,
      // Due immediately: a new feed should have items before the user has
      // finished reading the confirmation.
      next_fetch_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (inserted) return { id: inserted.id as string, created: true };

  // Unique-violation: somebody else created it between our read and write.
  if (error) {
    const { data: raced } = await supabase
      .from("promo_feed")
      .select("id")
      .eq("feed_url", input.feedUrl)
      .maybeSingle();
    if (raced) return { id: raced.id as string, created: false };
  }
  return null;
}

export type KeywordSourceOutcome = {
  keyword: string;
  slug: string;
  ok: boolean;
  /** Set when the topic could not be added. */
  error?: string;
  sourceId?: string;
  feedId?: string;
};

/**
 * Turn a parsed keyword list into one source per keyword.
 *
 * Every keyword is reported on individually: "bitcoin and ethereum were added,
 * zzz is not a topic yet" is far more useful than one blanket failure.
 */
export async function addKeywordSources(
  supabase: SupabaseClient<any>,
  input: {
    listId: string;
    keywords: KeywordInput[];
    ownership: "owned" | "partner" | "shared";
  },
  fetchImpl?: FetchLike,
): Promise<KeywordSourceOutcome[]> {
  const outcomes: KeywordSourceOutcome[] = [];

  for (const keyword of input.keywords) {
    const feedUrl = topicFeedUrl(keyword.slug);
    const validation = await validateFeedUrl(feedUrl, fetchImpl);
    if (!validation.ok) {
      outcomes.push({
        keyword: keyword.label,
        slug: keyword.slug,
        ok: false,
        error:
          validation.error.includes("404")
            ? `No RSS Amplifier topic for "${keyword.label}" yet.`
            : validation.error,
      });
      continue;
    }

    const feed = await ensureFeed(supabase, {
      feedUrl,
      kind: "rssamplifier_topic",
      topicSlug: keyword.slug,
      title: validation.title,
    });
    if (!feed) {
      outcomes.push({
        keyword: keyword.label,
        slug: keyword.slug,
        ok: false,
        error: "Could not register that topic feed.",
      });
      continue;
    }

    const { data: source, error } = await supabase
      .from("promo_source")
      .insert({
        list_id: input.listId,
        feed_id: feed.id,
        type: "rssamplifier_topic",
        ownership: input.ownership,
        label: keyword.label,
        keyword: keyword.label,
      })
      .select("id")
      .single();

    if (error || !source) {
      // unique (list_id, feed_id): the list already tracks this topic.
      outcomes.push({
        keyword: keyword.label,
        slug: keyword.slug,
        ok: false,
        error: "Already tracked by this campaign.",
      });
      continue;
    }

    outcomes.push({
      keyword: keyword.label,
      slug: keyword.slug,
      ok: true,
      sourceId: source.id as string,
      feedId: feed.id,
    });
  }

  return outcomes;
}
