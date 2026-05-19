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
  input: { selfSiteId: string; selfNiche: string | null; keyword: string; slots: number },
): ExchangeCandidate[] {
  const { selfSiteId, selfNiche, keyword, slots } = input;
  if (slots <= 0) return [];

  const selfTokens = topicTokens(keyword, selfNiche);
  if (selfTokens.size === 0) return [];

  const scored = rows
    .filter((r) => r.site.id !== selfSiteId)
    .map((r) => ({
      row: r,
      score: scoreOverlap(
        selfTokens,
        topicTokens(r.title, r.meta_description, r.site.niche),
      ),
    }))
    .filter((s) => s.score > 0)
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

// Fetch + rank in one call. The PostgREST embed pulls the site columns
// we need for filtering and URL construction in a single round-trip.
export async function findExchangeCandidates(
  supabase: SupabaseClient<any>,
  input: { selfSiteId: string; selfNiche: string | null; keyword: string; slots: number },
): Promise<ExchangeCandidate[]> {
  if (input.slots <= 0) return [];

  // Cap the candidate pool so a large network can't blow up the prompt
  // or the ranking loop. slots*8 gives the ranker enough headroom to
  // filter on niche overlap and still meet the slot count.
  const limit = Math.max(20, input.slots * 8);

  const { data, error } = await supabase
    .from("lx_article")
    .select(
      `id, title, slug, meta_description, status,
       site:lx_site!inner(id, domain, blog_root_url, niche, status, backlinks_enabled, inappropriate_content)`,
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
    return [];
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
  return rankExchangeCandidates(rows, input);
}
