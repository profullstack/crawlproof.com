// What serving needs to know about trends, cheaply enough to ask on every fill.
//
// Three facts are needed to prefer a trending-targeted campaign: which
// campaigns opted in and what subjects they claim, what is trending, and what
// the page being filled is about. Asked naively that is three extra queries on
// the hottest path in the product.
//
// So the two that are the same for everybody — the opt-ins and the trend list
// — are cached in the module for a minute, and the third is only asked at all
// once we know a candidate opted in. On a network where nobody has enabled
// trending targeting, this costs one small cached query per minute and nothing
// per fill.
//
// Every failure here reads as "no trending campaigns", which is exactly how
// serving behaved before this existed. A trend list is a preference; nothing
// about it is worth failing a fill over.

import type { SupabaseClient } from "@supabase/supabase-js";
import { currentTrends } from "./trends";
import { cleanTopics, pageTopics, type TrendSignal } from "./trending";
import { promosForCampaigns } from "./promos";
import { promoState, type Promo } from "./trending";

/** How long the shared facts are held. A minute is invisible to a 90-day promo. */
export const CACHE_MS = 60_000;

type Cached<T> = { at: number; value: T } | null;

let optInCache: Cached<Map<string, string[]>> = null;
let trendCache: Cached<TrendSignal[]> = null;

/** Tests and long-lived processes that change the data underneath us. */
export function resetTrendCaches(): void {
  optInCache = null;
  trendCache = null;
}

/**
 * Campaigns that opted into trending targeting, and the subjects they claim.
 *
 * One query against the partial index on `trending_topics`, so on a network
 * with none it reads nothing at all. A missing column (the migration is
 * applied by hand, so a deploy can lead it) is an empty map.
 */
export async function trendingCampaigns(
  sb: SupabaseClient,
  now = Date.now(),
): Promise<Map<string, string[]>> {
  if (optInCache && now - optInCache.at < CACHE_MS) return optInCache.value;
  const map = new Map<string, string[]>();
  try {
    const { data, error } = await sb
      .from("ad_campaigns")
      .select("id, topics")
      .eq("trending_topics", true)
      .in("status", ["active", "exhausted"])
      .limit(500);
    if (!error && data) {
      for (const row of data as { id: string; topics: string[] | null }[]) {
        map.set(row.id, cleanTopics(row.topics ?? []));
      }
    }
  } catch {
    // Fall through to the empty map.
  }
  optInCache = { at: now, value: map };
  return map;
}

/** The current trend list, cached for the same minute. */
export async function trendSignals(sb: SupabaseClient, now = Date.now()): Promise<TrendSignal[]> {
  if (trendCache && now - trendCache.at < CACHE_MS) return trendCache.value;
  const signals = await currentTrends(sb, { now });
  trendCache = { at: now, value: signals };
  return signals;
}

/**
 * What the page being filled is about.
 *
 * Read from what CrawlProof already knows about the publisher's site: the
 * autoblog's hand-checked subject list for it, the niche that list came from,
 * and the slot's own niche. Not cached — it is per-slot and only asked when a
 * trending-targeted campaign is actually in the running.
 */
export async function topicsForSlot(
  sb: SupabaseClient,
  slot: { project_id?: string | null; niche?: string | null },
): Promise<string[]> {
  const slotNiche = slot.niche ?? null;
  if (!slot.project_id) return pageTopics({ slotNiche });
  try {
    const [{ data: site }, { data: project }] = await Promise.all([
      sb.from("lx_site").select("master_keywords, niche").eq("project_id", slot.project_id).maybeSingle(),
      sb.from("projects").select("name").eq("id", slot.project_id).maybeSingle(),
    ]);
    return pageTopics({
      masterKeywords: (site as { master_keywords?: string[] | null } | null)?.master_keywords ?? null,
      niche: (site as { niche?: string | null } | null)?.niche ?? null,
      slotNiche,
      projectName: (project as { name?: string | null } | null)?.name ?? null,
    });
  } catch {
    return pageTopics({ slotNiche });
  }
}

export type TrendContext = {
  /** Campaign id → the subjects it claims. Empty when nobody opted in. */
  optIns: Map<string, string[]>;
  trends: TrendSignal[];
  /** What the slot's page is about. Empty until somebody opted in. */
  page: string[];
  /** Campaign id → its live promo, if any. */
  promos: Map<string, Promo>;
  /** True when some candidate opted in, so the rest of this is worth reading. */
  any: boolean;
};

export const EMPTY_CONTEXT: TrendContext = {
  optIns: new Map(),
  trends: [],
  page: [],
  promos: new Map(),
  any: false,
};

/**
 * Everything the fill needs, or nothing.
 *
 * `candidateIds` are the campaigns already in the running for this fill. If
 * none of them opted in, this stops after the cached opt-in read — no trend
 * query, no page query, no promo query.
 */
export async function trendContextFor(
  sb: SupabaseClient,
  slot: { project_id?: string | null; niche?: string | null },
  candidateIds: string[],
  now = Date.now(),
): Promise<TrendContext> {
  const optIns = await trendingCampaigns(sb, now);
  if (!optIns.size) return EMPTY_CONTEXT;
  const relevant = candidateIds.filter((id) => optIns.has(id));
  if (!relevant.length) return EMPTY_CONTEXT;

  const [trends, page, promos] = await Promise.all([
    trendSignals(sb, now),
    topicsForSlot(sb, slot),
    promosForCampaigns(sb, relevant),
  ]);
  return { optIns, trends, page, promos, any: true };
}

/** Is this campaign's promo running right now? */
export function promoActiveFor(context: TrendContext, campaignId: string, now = Date.now()): boolean {
  return promoState(context.promos.get(campaignId) ?? null, now).active;
}
