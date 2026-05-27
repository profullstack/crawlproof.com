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
  seed_keywords: string[];
  keywords: string[];
  publish_days: number[];
  publish_hour: number;
  daily_article_count: number;
};

const TARGET_KEYWORDS = 30;
const MIN_VOLUME = 50;
const MIN_WORDS = 2;
const PER_SEED_LIMIT = 200;
const SEED_TOKEN_STOPLIST = new Set([
  "the","and","for","with","you","your","that","this","from","into","over",
  "but","not","are","was","were","has","had","have","its","off","out","all",
  "any","new","get","how","why","what","who","best","top",
]);

function buildSeeds(site: SiteRow): string[] {
  const seeds: string[] = [];
  for (const s of site.seed_keywords ?? []) seeds.push(s.trim());
  if (site.niche) seeds.push(site.niche.trim());
  for (const a of site.target_audiences.slice(0, 3)) {
    if (site.niche && a) seeds.push(`${site.niche} for ${a}`);
    else if (a) seeds.push(a);
  }
  return Array.from(new Set(seeds.filter((s) => s.length > 0))).slice(0, 5);
}

function parseStoredKeyword(row: string): DfsKeywordRow | null {
  const idx = row.indexOf(",");
  const keyword = (idx === -1 ? row : row.slice(0, idx)).trim();
  if (keyword.length < 2) return null;
  const volumeRaw = idx === -1 ? "" : row.slice(idx + 1).trim();
  const volume = /^\d+$/.test(volumeRaw) ? parseInt(volumeRaw, 10) : null;
  return {
    keyword,
    search_volume: volume,
    competition: null,
    competition_index: null,
    cpc: null,
    low_top_of_page_bid: null,
    high_top_of_page_bid: null,
    monthly_searches: null,
  };
}

function seedTokens(seed: string): string[] {
  return seed
    .toLowerCase()
    .split(/[\s-]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 4 && !SEED_TOKEN_STOPLIST.has(t));
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
      "id, niche, target_audiences, seed_keywords, keywords, publish_days, publish_hour, daily_article_count",
    )
    .eq("id", siteId)
    .maybeSingle<SiteRow>();
  if (!site) {
    return { ok: false, inserted: 0, apiCost: 0, error: "site not found" };
  }

  const savedKeywords = (site.keywords ?? [])
    .map(parseStoredKeyword)
    .filter((r): r is DfsKeywordRow => !!r);
  const seeds = buildSeeds(site);
  if (savedKeywords.length === 0 && seeds.length === 0) {
    return {
      ok: false,
      inserted: 0,
      apiCost: 0,
      error: "add saved keywords or seed keywords first",
    };
  }

  // Skip keywords this site already has in active/history states. Failed
  // rows are intentionally ignored here: an upstream outage should not
  // permanently poison a topic and prevent the top-up sweep from
  // refilling the queue.
  const { data: existingRows } = await supabase
    .from("lx_keyword")
    .select("keyword, status")
    .eq("site_id", site.id);
  const existingSet = new Set(
    (existingRows ?? [])
      .filter((r: { status: string }) => r.status !== "failed")
      .map((r: { keyword: string }) => r.keyword.toLowerCase()),
  );

  const savedChosen = dedupeBySite(savedKeywords, existingSet).slice(0, TARGET_KEYWORDS);

  // If the saved long-tail list does not fill the target queue, top it
  // up using the same DataForSEO Labs endpoint + relevance gate used by
  // the settings page's "Refetch keywords" flow.
  const allRows: DfsKeywordRow[] = [];
  let totalCost = 0;
  const seedErrors: string[] = [];
  if (savedChosen.length < TARGET_KEYWORDS && seeds.length > 0) {
    for (const seed of seeds.slice(0, 3)) {
      try {
        const result = await dfs.keywordIdeas([seed], {
          limit: PER_SEED_LIMIT,
          minVolume: MIN_VOLUME,
          minWords: MIN_WORDS,
          closelyVariants: false,
        });
        totalCost += result.cost;
        await supabase.from("lx_dataforseo_usage").insert({
          task_id: result.taskId,
          endpoint: "keyword_ideas/live",
          cost: result.cost,
          site_id: site.id,
        });

        const tokens = seedTokens(seed);
        const relevant = tokens.length === 0
          ? result.rows
          : result.rows.filter((r) => {
              const kw = r.keyword.toLowerCase();
              return tokens.some((t) => kw.includes(t));
            });
        allRows.push(...relevant);
      } catch (err) {
        seedErrors.push(
          `"${seed}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const filtered = filterOutliers(allRows).filter(
    (r) => (r.search_volume ?? 0) >= MIN_VOLUME,
  );
  const ranked = rankKeywords(filtered);
  const existingWithSaved = new Set(existingSet);
  for (const r of savedChosen) existingWithSaved.add(r.keyword.toLowerCase());
  const researchedChosen = dedupeBySite(ranked, existingWithSaved).slice(
    0,
    TARGET_KEYWORDS - savedChosen.length,
  );
  const chosen = [...savedChosen, ...researchedChosen].slice(0, TARGET_KEYWORDS);
  if (chosen.length === 0) {
    const details = seedErrors.length > 0
      ? ` Seed errors: ${seedErrors.join("; ")}`
      : "";
    return {
      ok: false,
      inserted: 0,
      apiCost: totalCost,
      error:
        "No new keyword candidates found. Saved keywords may already be published or queued; add new seed keywords/settings and try again." +
        details,
    };
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
