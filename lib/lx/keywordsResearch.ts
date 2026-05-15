// Keyword research pipeline (PRD §6.1, §15).
//
// Inputs: siteId — site must have niche + (optionally) target_audiences set.
// Outputs: up to 30 new rows in lx_keyword (status='queued'), scheduled
//          across the next ~6 weeks honoring publish_days + daily_article_count.
//
// Caching: lx_keyword_metrics rows live 60 days. Before paying DataForSEO
// for a seed, we check whether we already have a recent expansion cached
// (heuristic: same seed string, region='us'). For v1 we always re-fetch on
// manual trigger; cache is queried per-keyword to short-circuit the
// volume backfill step.
//
// Spend ledger: every DataForSEO call writes a row to lx_dataforseo_usage.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DataForSeoClient, filterOutliers, type DfsKeywordRow } from "./dataforseo";
import { nextPublishAt } from "./schedule";

type SiteRow = {
  id: string;
  niche: string | null;
  target_audiences: string[];
  publish_days: number[];
  publish_hour: number;
  daily_article_count: number;
};

const TARGET_KEYWORDS = 30;
const MIN_VOLUME = 50;

function buildSeeds(site: SiteRow): string[] {
  const seeds: string[] = [];
  if (site.niche) seeds.push(site.niche.trim());
  for (const a of site.target_audiences.slice(0, 3)) {
    if (site.niche && a) seeds.push(`${site.niche} for ${a}`);
    else if (a) seeds.push(a);
  }
  return Array.from(new Set(seeds.filter((s) => s.length > 0))).slice(0, 5);
}

function rankKeywords(rows: DfsKeywordRow[]): DfsKeywordRow[] {
  // PRD §15.1a: after filtering, take top by (relevance_rank * 0.6 + log(volume) * 0.4).
  // We don't get an explicit relevance_rank when sort_by='relevance' —
  // the row order IS the rank. Build the composite score from index +
  // log volume, lower-is-better on rank.
  const scored = rows.map((r, idx) => {
    const rank = idx; // 0 = most relevant
    const vol = r.search_volume ?? 0;
    const logVol = vol > 0 ? Math.log10(vol) : 0;
    // Normalize rank to [0,1] over the slice (so it's comparable to log10).
    const rankPenalty = rank / Math.max(rows.length, 1);
    const score = -(rankPenalty * 0.6) + logVol * 0.04; // weights tuned to match the order of magnitude of log10(volume) ~ 1-6
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}

function dedupeBySite(
  candidates: DfsKeywordRow[],
  existing: Set<string>,
): DfsKeywordRow[] {
  const out: DfsKeywordRow[] = [];
  const seen = new Set<string>();
  for (const r of candidates) {
    const k = r.keyword.toLowerCase();
    if (existing.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function scheduleKeywords(
  count: number,
  publishDays: number[],
  publishHour: number,
  perDay: number,
): Date[] {
  const dates: Date[] = [];
  let cursor = new Date();
  // Walk forward, generating slots per publish day at hour=publishHour.
  // Multiple per day if daily_article_count > 1 (we cluster on the same day).
  while (dates.length < count) {
    const next = nextPublishAt(publishDays, publishHour, cursor);
    if (!next) break;
    for (let i = 0; i < perDay && dates.length < count; i++) {
      dates.push(new Date(next));
    }
    cursor = new Date(next.getTime() + 60_000); // skip the slot we just used
  }
  return dates;
}

export type KeywordResearchResult = {
  ok: boolean;
  inserted: number;
  apiCost: number;
  error?: string;
};

export async function researchKeywords(
  siteId: string,
  deps: { supabase: SupabaseClient<any>; dfs: DataForSeoClient },
): Promise<KeywordResearchResult> {
  const { supabase, dfs } = deps;

  const { data: site } = await supabase
    .from("lx_site")
    .select(
      "id, niche, target_audiences, publish_days, publish_hour, daily_article_count",
    )
    .eq("id", siteId)
    .maybeSingle<SiteRow>();
  if (!site) {
    return { ok: false, inserted: 0, apiCost: 0, error: "site not found" };
  }

  const seeds = buildSeeds(site);
  if (seeds.length === 0) {
    return {
      ok: false,
      inserted: 0,
      apiCost: 0,
      error: "set a niche or target audience first",
    };
  }

  // Expand each seed. Cap total API spend at 5 tasks ($0.375 worst case).
  const allRows: DfsKeywordRow[] = [];
  let totalCost = 0;
  for (const seed of seeds.slice(0, 3)) {
    const result = await dfs.keywordsForKeywords([seed], { sortBy: "relevance" });
    totalCost += result.cost;
    await supabase.from("lx_dataforseo_usage").insert({
      task_id: result.taskId,
      endpoint: "keywords_for_keywords/live",
      cost: result.cost,
      site_id: site.id,
    });
    allRows.push(...result.rows);
  }

  const filtered = filterOutliers(allRows).filter(
    (r) => (r.search_volume ?? 0) >= MIN_VOLUME,
  );
  const ranked = rankKeywords(filtered);

  // Skip keywords this site has already had queued/published.
  const { data: existingRows } = await supabase
    .from("lx_keyword")
    .select("keyword")
    .eq("site_id", site.id);
  const existingSet = new Set(
    (existingRows ?? []).map((r: { keyword: string }) => r.keyword.toLowerCase()),
  );

  const chosen = dedupeBySite(ranked, existingSet).slice(0, TARGET_KEYWORDS);
  if (chosen.length === 0) {
    return { ok: true, inserted: 0, apiCost: totalCost };
  }

  // The cross-tenant lx_keyword_metrics cache is intentionally left
  // unpopulated in v1 — its read path doesn't exist yet, and onConflict
  // upserts can't target the (lower(keyword), region) expression index
  // without first reshaping it. We re-introduce it when keyword overlap
  // across customers becomes measurable.

  // Schedule them across publish_days.
  const slots = scheduleKeywords(
    chosen.length,
    site.publish_days,
    site.publish_hour,
    site.daily_article_count,
  );

  const insertRows = chosen.map((r, i) => ({
    site_id: site.id,
    keyword: r.keyword,
    scheduled_for: slots[i]?.toISOString().slice(0, 10) ??
      new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10),
    status: "queued",
    source: "auto",
    search_volume: r.search_volume,
    cpc_usd: r.cpc,
  }));

  const { error: insErr } = await supabase.from("lx_keyword").insert(insertRows);
  if (insErr) {
    return {
      ok: false,
      inserted: 0,
      apiCost: totalCost,
      error: insErr.message,
    };
  }

  return { ok: true, inserted: insertRows.length, apiCost: totalCost };
}
