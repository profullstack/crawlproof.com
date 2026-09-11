// Pulling the trend list in, and reading it back out.
//
// chovy.com's SameBrain endpoint answers "what are founders trying to build
// this week" as a list of subjects with a score. This module fetches that over
// a shared secret, normalises it, and stores it as targeting signals. Serving
// reads `currentTrends`; nothing on the serving path ever reaches chovy.com.
//
// The secret lives in the vault (logicsrc team `crawlproof-com--prod`) as
// SAMEBRAIN_SECRET and is set as an environment variable on the Railway
// service — never in a committed .env file.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TREND_SOURCE,
  TREND_WINDOW_DAYS,
  normalizeTopic,
  trendsAreStale,
  type TrendSignal,
} from "./trending";

export type IngestResult =
  | { ok: true; source: string; windowDays: number; stored: number; removed: number; generatedAt: string | null }
  | { ok: false; status: number; error: string };

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * What the source sent, turned into rows we are willing to store.
 *
 * Written defensively on purpose: this is the one place another service's JSON
 * reaches our database, and a trend list is not worth a single unchecked
 * value. Topics that normalise to nothing are dropped rather than stored as
 * empty strings that would then match every page.
 */
export function parseTrendPayload(
  payload: unknown,
  options: { windowDays?: number; limit?: number } = {},
): { ok: true; signals: TrendSignal[]; generatedAt: string | null } | { ok: false; error: string } {
  const body = (payload ?? {}) as Record<string, unknown>;
  const rawTopics = body.topics;
  if (!Array.isArray(rawTopics)) return { ok: false, error: "The trend source answered without a topics array." };

  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 32) : TREND_SOURCE;
  const windowDays = clampNumber(body.window_days ?? options.windowDays, 1, 90, TREND_WINDOW_DAYS);
  const generatedAtRaw = body.generated_at;
  const generatedAt =
    typeof generatedAtRaw === "number" && Number.isFinite(generatedAtRaw)
      ? new Date(generatedAtRaw).toISOString()
      : typeof generatedAtRaw === "string" && Number.isFinite(Date.parse(generatedAtRaw))
        ? new Date(Date.parse(generatedAtRaw)).toISOString()
        : null;

  const limit = clampNumber(options.limit, 1, 200, 50);
  const seen = new Set<string>();
  const signals: TrendSignal[] = [];
  for (const item of rawTopics) {
    const row = (item ?? {}) as Record<string, unknown>;
    const topic = normalizeTopic(String(row.topic ?? ""));
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    signals.push({
      source,
      topic,
      score: clampNumber(row.score, 0, 1_000_000, 0),
      mentions: Math.round(clampNumber(row.count ?? row.mentions, 0, 1_000_000, 0)),
      priorMentions: Math.round(clampNumber(row.prior_count ?? row.priorMentions, 0, 1_000_000, 0)),
      windowDays: Math.round(clampNumber(row.window_days ?? windowDays, 1, 90, windowDays)),
      generatedAt,
      ingestedAt: null,
    });
    if (signals.length >= limit) break;
  }
  return { ok: true, signals, generatedAt };
}

export type TrendSourceConfig = {
  /** Base URL of the trend source, e.g. https://chovy.com */
  url: string;
  secret: string;
  windowDays?: number;
  limit?: number;
};

/**
 * Ask the source what is trending.
 *
 * Server to server, bearer secret, short timeout: this runs on a schedule and
 * a trend list is never worth holding a request open for. A failure here is
 * not an outage — serving falls back to the stored list, and past
 * TREND_MAX_AGE_HOURS to no trend targeting at all.
 */
export async function fetchTrends(
  config: TrendSourceConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; signals: TrendSignal[]; generatedAt: string | null } | { ok: false; status: number; error: string }> {
  if (!config.url) return { ok: false, status: 503, error: "No trend source configured (SAMEBRAIN_URL)." };
  if (!config.secret) return { ok: false, status: 503, error: "No trend source secret configured (SAMEBRAIN_SECRET)." };

  const windowDays = Math.round(clampNumber(config.windowDays, 1, 90, TREND_WINDOW_DAYS));
  const limit = Math.round(clampNumber(config.limit, 1, 200, 50));
  const base = config.url.replace(/\/$/, "");
  const url = `${base}/api/samebrain/trending?window=${windowDays}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${config.secret}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : "The trend source could not be reached." };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: `The trend source answered ${response.status}.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "The trend source answered with something that is not JSON." };
  }
  const parsed = parseTrendPayload(payload, { windowDays, limit });
  if (!parsed.ok) return { ok: false, status: 502, error: parsed.error };
  return parsed;
}

/**
 * Replace the stored list for this source and window.
 *
 * Replace rather than append: "what is trending" is a current fact, and a
 * month of history would only ever be read as its latest row. Rows the new
 * list does not mention are deleted, so a subject that stops trending stops
 * steering delivery rather than lingering at its last score forever.
 */
export async function storeTrends(
  sb: SupabaseClient,
  signals: TrendSignal[],
  options: { source?: string; windowDays?: number } = {},
): Promise<{ stored: number; removed: number }> {
  const source = options.source ?? signals[0]?.source ?? TREND_SOURCE;
  const windowDays = options.windowDays ?? signals[0]?.windowDays ?? TREND_WINDOW_DAYS;
  const ingestedAt = new Date().toISOString();

  const rows = signals.map((signal) => ({
    source,
    topic: signal.topic,
    mentions: signal.mentions,
    prior_mentions: signal.priorMentions,
    score: signal.score,
    window_days: windowDays,
    generated_at: signal.generatedAt,
    ingested_at: ingestedAt,
  }));

  if (rows.length) {
    const { error } = await sb.from("ad_trend_topics").upsert(rows, { onConflict: "source,window_days,topic" });
    // The unique index is on lower(topic), which PostgREST cannot name as a
    // conflict target. Fall back to delete-then-insert for the same effect.
    if (error) {
      await sb.from("ad_trend_topics").delete().eq("source", source).eq("window_days", windowDays);
      const { error: insertError } = await sb.from("ad_trend_topics").insert(rows);
      if (insertError) throw new Error(insertError.message);
      return { stored: rows.length, removed: 0 };
    }
  }

  // Anything not in this pull is no longer trending.
  const keep = rows.map((row) => row.topic);
  let removed = 0;
  if (keep.length) {
    const { data } = await sb
      .from("ad_trend_topics")
      .delete()
      .eq("source", source)
      .eq("window_days", windowDays)
      .not("topic", "in", `(${keep.map((topic) => `"${topic.replace(/"/g, "")}"`).join(",")})`)
      .select("id");
    removed = (data ?? []).length;
  }
  return { stored: rows.length, removed };
}

/** Pull and store in one call. What the cron route and the CLI both run. */
export async function ingestTrends(
  sb: SupabaseClient,
  config: TrendSourceConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestResult> {
  const fetched = await fetchTrends(config, fetchImpl);
  if (!fetched.ok) return fetched;
  const windowDays = Math.round(clampNumber(config.windowDays, 1, 90, TREND_WINDOW_DAYS));
  try {
    const { stored, removed } = await storeTrends(sb, fetched.signals, { windowDays });
    return {
      ok: true,
      source: fetched.signals[0]?.source ?? TREND_SOURCE,
      windowDays,
      stored,
      removed,
      generatedAt: fetched.generatedAt,
    };
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : "The trend list could not be stored." };
  }
}

type TrendRow = {
  source: string;
  topic: string;
  mentions: number | null;
  prior_mentions: number | null;
  score: number | null;
  window_days: number | null;
  generated_at: string | null;
  ingested_at: string | null;
};

const rowToSignal = (row: TrendRow): TrendSignal => ({
  source: row.source,
  topic: row.topic,
  score: Number(row.score) || 0,
  mentions: Number(row.mentions) || 0,
  priorMentions: Number(row.prior_mentions) || 0,
  windowDays: Number(row.window_days) || TREND_WINDOW_DAYS,
  generatedAt: row.generated_at,
  ingestedAt: row.ingested_at,
});

/**
 * What is trending right now, for serving and for reporting.
 *
 * Stale rows are dropped rather than returned: past TREND_MAX_AGE_HOURS the
 * list describes a different week, and steering delivery on it is worse than
 * not steering it at all. A caller that wants to show the stale list anyway
 * (the CLI does, to explain why nothing is being boosted) passes
 * `includeStale`.
 */
export async function currentTrends(
  sb: SupabaseClient,
  options: { source?: string; windowDays?: number; limit?: number; includeStale?: boolean; now?: number } = {},
): Promise<TrendSignal[]> {
  const source = options.source ?? TREND_SOURCE;
  const windowDays = options.windowDays ?? TREND_WINDOW_DAYS;
  const limit = Math.round(clampNumber(options.limit, 1, 200, 50));
  try {
    const { data, error } = await sb
      .from("ad_trend_topics")
      .select("source, topic, mentions, prior_mentions, score, window_days, generated_at, ingested_at")
      .eq("source", source)
      .eq("window_days", windowDays)
      .order("score", { ascending: false })
      .limit(limit);
    // Missing table (migration applied by hand, deploy may lead it) reads as
    // "nothing is trending", which is the behaviour that existed before.
    if (error || !data) return [];
    const signals = (data as TrendRow[]).map(rowToSignal);
    if (options.includeStale) return signals;
    return signals.filter((signal) => !trendsAreStale(signal.ingestedAt, options.now ?? Date.now()));
  } catch {
    return [];
  }
}
