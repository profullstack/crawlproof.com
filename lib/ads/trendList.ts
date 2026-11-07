// The trend list as outsiders see it: the public API and the MCP tool answer with
// this, so the two cannot drift apart.

import type { SupabaseClient } from "@supabase/supabase-js";
import { currentTrends } from "./trends";
import { TREND_MAX_AGE_HOURS, TREND_SOURCE, TREND_WINDOW_DAYS, trendsAreStale } from "./trending";

/** Where a subject can be searched. */
export function pitSearchUrl(subject: string): string {
  return `https://pit.world/search?q=${encodeURIComponent(subject)}`;
}

export async function publicTrendList(sb: SupabaseClient, options: { limit?: number; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const limit = Math.min(200, Math.max(1, Math.round(Number(options.limit)) || 50));
  const signals = await currentTrends(sb, { limit, includeStale: true, now });
  const newest = signals.reduce<string | null>(
    (latest, signal) => (!latest || (signal.ingestedAt ?? "") > latest ? (signal.ingestedAt ?? latest) : latest),
    null,
  );
  return {
    source: TREND_SOURCE,
    window_days: TREND_WINDOW_DAYS,
    ingested_at: newest,
    // Past this the list no longer steers delivery, and an agent should know.
    stale: signals.length > 0 && trendsAreStale(newest, now),
    max_age_hours: TREND_MAX_AGE_HOURS,
    topics: signals.map((signal) => ({
      topic: signal.label ?? signal.topic,
      match_key: signal.topic,
      score: signal.score,
      feeds: signal.mentions,
      prior_feeds: signal.priorMentions,
      search_url: pitSearchUrl(signal.label ?? signal.topic),
    })),
  };
}
