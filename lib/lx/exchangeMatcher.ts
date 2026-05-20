// Phase 3 — Link Exchange matcher.
//
// Given a generating site + the current article's topic, find articles
// on OTHER sites in the network whose topic is close enough that linking
// out makes editorial sense. The matcher only considers sites that have
// opted in (lx_site.backlinks_enabled = true). Reciprocity is implicit:
// every opted-in site is both a potential giver and a potential receiver.
//
// v1 ranking: token-overlap on (article title + meta_description + site
// niche) vs (current keyword + current site niche). No vector lookup —
// the corpus is small enough that the cheap pass beats roundtripping an
// embedding through pgvector, and it stays explainable in the logs.
//
// Hard rules (not heuristics):
// - Exclude self.
// - Exclude paused/flagged sites.
// - Exclude sites flagged inappropriate_content.
// - Cap to one candidate per giver site (spread the love).
// - Score must be > 0 — we'd rather return zero links than insert
//   off-topic ones into a published post.
//
// Anti-PBN posture: this is recorded in lx_backlink, surfaced to the
// owner of both sides, and gated by Phase 2's receiver-side niche +
// quality check. It is not a hidden link-equity loop.
//
// To extend: replace tokenOverlap() with a pgvector-backed similarity
// once lx_article gets an embedding column, and add a fair-share term
// that down-weights sites that have received recently from this giver.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ExchangeCandidate = {
  site_id: string;
  domain: string;
  niche: string | null;
  article_id: string;
  url: string;
  title: string;
  meta_description: string | null;
};

// Below this many eligible articles in the network, the matcher relaxes
// its "score > 0" requirement and will surface the freshest candidates
// even with zero topic overlap. Once the corpus is large enough, niche
// overlap reliably finds something for any given keyword and strict
// mode kicks back in. Tuned to ~250 sites × ~10 articles each.
export const RELAXED_NICHE_THRESHOLD = 2500;

type RankableRow = {
  id: string;
  title: string;
  slug: string;
  meta_description: string | null;
  site: {
    id: string;
    domain: string;
    blog_root_url: string;
    niche: string | null;
  };
};

// Standard English stopwords for niche/title tokenization. Kept tiny —
// we want to keep nouns like "API" and "SOC", so anything longer than
// the most common functional words stays in.
const STOPWORDS = new Set([
  "a", "an", "and", "or", "but", "the", "of", "for", "to", "in",
  "on", "at", "by", "with", "as", "is", "are", "be", "was", "were",
  "this", "that", "these", "those", "it", "its",
]);

export function topicTokens(...sources: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!raw) continue;
      if (raw.length < 3) continue;
      if (STOPWORDS.has(raw)) continue;
      out.add(raw);
    }
  }
  return out;
}

export function scoreOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function buildArticleUrl(blogRootUrl: string, slug: string): string {
  // Receiver convention: blog_root_url is the directory under which
  // posts live; the slug is appended. Tolerate trailing/missing slashes.
  const base = blogRootUrl.replace(/\/+$/, "");
  const s = slug.replace(/^\/+/, "");
  return `${base}/${s}`;
}

export function rankExchangeCandidates(
  rows: RankableRow[],
  input: {
    selfSiteId: string;
    selfNiche: string | null;
    keyword: string;
    slots: number;
    // Minimum overlap score to accept. Defaults to 1 (strict — require
    // some topical overlap). Caller passes 0 in early-network "relaxed"
    // mode so the matcher can still find SOMETHING when the corpus is
    // too thin for niche overlap to fire reliably.
    minScore?: number;
  },
): ExchangeCandidate[] {
  const { selfSiteId, selfNiche, keyword, slots } = input;
  const minScore = input.minScore ?? 1;
  if (slots <= 0) return [];

  const selfTokens = topicTokens(keyword, selfNiche);
  // In relaxed mode (minScore = 0) we still surface candidates even if
  // the self-token set is empty — the network's just too small to be
  // picky. In strict mode, no self-tokens means nothing to match against.
  if (selfTokens.size === 0 && minScore > 0) return [];

  const scored = rows
    .filter((r) => r.site.id !== selfSiteId)
    .map((r) => ({
      row: r,
      score: scoreOverlap(
        selfTokens,
        topicTokens(r.title, r.meta_description, r.site.niche),
      ),
    }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const out: ExchangeCandidate[] = [];
  const seenSites = new Set<string>();
  for (const { row } of scored) {
    if (seenSites.has(row.site.id)) continue;
    seenSites.add(row.site.id);
    out.push({
      site_id: row.site.id,
      domain: row.site.domain,
      niche: row.site.niche,
      article_id: row.id,
      url: buildArticleUrl(row.site.blog_root_url, row.slug),
      title: row.title,
      meta_description: row.meta_description,
    });
    if (out.length >= slots) break;
  }
  return out;
}

export type ExchangeMatchResult = {
  candidates: ExchangeCandidate[];
  // True when the network is below RELAXED_NICHE_THRESHOLD — we surfaced
  // candidates without requiring topical overlap. Callers can use this
  // to soften prompt language so the model actually uses what we found.
  relaxed: boolean;
  networkSize: number;
};

// Fetch + rank in one call. The PostgREST embed pulls the site columns
// we need for filtering and URL construction in a single round-trip.
export async function findExchangeCandidates(
  supabase: SupabaseClient<any>,
  input: { selfSiteId: string; selfNiche: string | null; keyword: string; slots: number },
): Promise<ExchangeMatchResult> {
  if (input.slots <= 0) {
    return { candidates: [], relaxed: false, networkSize: 0 };
  }

  // Cap the candidate pool so a large network can't blow up the prompt
  // or the ranking loop. In relaxed mode we widen the pull window so
  // recency-ordering has enough variety to choose from.
  const networkSize = await countEligibleNetworkArticles(supabase);
  const relaxed = networkSize < RELAXED_NICHE_THRESHOLD;
  const minScore = relaxed ? 0 : 1;
  const limit = Math.max(20, input.slots * (relaxed ? 12 : 8));

  const { data, error } = await supabase
    .from("lx_article")
    .select(
      `id, title, slug, meta_description, status,
       site:lx_site!lx_article_site_id_fkey!inner(id, domain, blog_root_url, niche, status, backlinks_enabled, inappropriate_content)`,
    )
    .in("status", ["ready", "published"])
    .eq("site.backlinks_enabled", true)
    .eq("site.status", "active")
    .eq("site.inappropriate_content", false)
    .neq("site.id", input.selfSiteId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("[lx] exchange matcher query failed:", error.message);
    return { candidates: [], relaxed, networkSize };
  }

  if (relaxed) {
    console.log(
      `[lx] exchange matcher running in RELAXED mode (network=${networkSize} < ${RELAXED_NICHE_THRESHOLD} eligible articles)`,
    );
  }
  // PostgREST's `!inner` embed types come back as `site: T[]` even though
  // the runtime shape is a single object once the inner join is applied.
  // Normalize so the ranker can operate on a stable RankableRow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: RankableRow[] = ((data as any[]) ?? []).map((r: any) => ({
    id: r.id,
    title: r.title,
    slug: r.slug,
    meta_description: r.meta_description,
    site: Array.isArray(r.site) ? r.site[0] : r.site,
  })).filter((r) => r.site);
  return {
    candidates: rankExchangeCandidates(rows, { ...input, minScore }),
    relaxed,
    networkSize,
  };
}

// Count of articles eligible to be exchanged across the whole network —
// the denominator that decides whether the matcher is in strict or
// relaxed mode. Counts opted-in, non-flagged, active-site rows only;
// a backlogged or paused site shouldn't push us into strict mode just
// by existing.
async function countEligibleNetworkArticles(
  supabase: SupabaseClient<any>,
): Promise<number> {
  const { count, error } = await supabase
    .from("lx_article")
    .select("id, site:lx_site!lx_article_site_id_fkey!inner(backlinks_enabled, status, inappropriate_content)", {
      count: "exact",
      head: true,
    })
    .in("status", ["ready", "published"])
    .eq("site.backlinks_enabled", true)
    .eq("site.status", "active")
    .eq("site.inappropriate_content", false);
  if (error) {
    console.warn("[lx] exchange network-size query failed:", error.message);
    // Fail safe: treat as small network, relax matching.
    return 0;
  }
  return count ?? 0;
}
