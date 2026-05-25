// "Find guest post opportunities for me" — discovery side.
//
// Inputs: the author site's own profile (niche, audiences, seeds,
// modifiers) and the network of other opted-in sites.
// Output: a ranked list of opportunities, each with a partner site and
// a few crossed-seed topic suggestions that genuinely bridge the two
// niches.
//
// Two-stage match:
//   1. Partner ranking — loose token overlap on (niche + audiences +
//      seeds) of BOTH sides. Same scoring shape as exchangeMatcher so
//      the relaxed-niche threshold logic carries over.
//   2. Topic crossing — cartesian product of A.seeds × B.seeds (and
//      A.modifiers × B.seeds, B.modifiers × A.seeds) producing short
//      phrases that contain at least one token from each side. These
//      seed the long-tail keyword for the guest post.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  topicTokens,
  scoreOverlap,
  RELAXED_NICHE_THRESHOLD,
} from "./exchangeMatcher";

export type GuestPostOpportunity = {
  partner_site_id: string;
  partner_domain: string;
  partner_niche: string | null;
  partner_blog_root_url: string | null;
  score: number;
  suggested_topics: string[];
};

type AuthorProfile = {
  id: string;
  niche: string | null;
  target_audiences: string[];
  seed_keywords: string[];
  modifiers: string[];
};

type PartnerRow = {
  id: string;
  domain: string;
  niche: string | null;
  blog_root_url: string | null;
  target_audiences: string[];
  seed_keywords: string[];
  modifiers: string[];
  status: string;
  backlinks_enabled: boolean;
  inappropriate_content: boolean;
};

const MAX_TOPICS_PER_OPPORTUNITY = 5;
const MAX_TOPIC_PHRASE_LEN = 70;
const MAX_OPPORTUNITIES = 12;

// Cartesian-cross two arrays of seed-like phrases into combined
// candidates. Keeps phrases short, dedup'd, and capped. Output order
// reflects (a × b) iteration so the highest-priority seeds of both
// sides appear first.
export function crossSeeds(left: string[], right: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of left) {
    const a = (l ?? "").trim();
    if (!a) continue;
    for (const r of right) {
      const b = (r ?? "").trim();
      if (!b) continue;
      // Skip when one side is a token-subset of the other — those
      // produce duplicates like "payments crypto payments".
      const al = a.toLowerCase();
      const bl = b.toLowerCase();
      if (al.includes(bl) || bl.includes(al)) continue;
      const phrase = `${a} ${b}`.toLowerCase();
      if (phrase.length > MAX_TOPIC_PHRASE_LEN) continue;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}

// Build the topic-suggestion list for a single (author, partner) pair.
// Order of operations matters — earlier sources rank higher, so the
// most "natural-feeling" crosses come first.
export function suggestTopics(
  author: AuthorProfile,
  partner: Pick<PartnerRow, "niche" | "seed_keywords" | "modifiers" | "target_audiences">,
): string[] {
  const authorSeeds = nonEmpty([
    ...author.seed_keywords,
    author.niche ?? "",
  ]);
  const partnerSeeds = nonEmpty([
    ...partner.seed_keywords,
    partner.niche ?? "",
  ]);
  const authorMods = nonEmpty(author.modifiers);
  const partnerMods = nonEmpty(partner.modifiers);
  const partnerAudiences = nonEmpty(partner.target_audiences);

  const all: string[] = [
    // Strongest cross: author's seeds (their authority topics) onto
    // the partner's niche / seeds (the topic the partner's readers care about).
    ...crossSeeds(authorSeeds, partnerSeeds),
    // Author seeds × partner audiences — "topic X for audience Y" style.
    ...crossSeeds(authorSeeds, partnerAudiences.map((a) => `for ${a}`)),
    // Author modifiers × partner seeds — modifiers narrow the angle.
    ...crossSeeds(authorMods, partnerSeeds),
    // Partner modifiers × author seeds — flips the narrowing.
    ...crossSeeds(partnerMods, authorSeeds),
  ];

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of all) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
    if (unique.length >= MAX_TOPICS_PER_OPPORTUNITY) break;
  }
  return unique;
}

function nonEmpty(xs: string[]): string[] {
  return xs.map((x) => (x ?? "").trim()).filter(Boolean);
}

// Rank partners against the author by token overlap of (niche +
// audiences + seeds). Below RELAXED_NICHE_THRESHOLD eligible articles
// we drop the minScore=1 requirement so a tiny network still surfaces
// something instead of returning empty.
export function rankPartners(
  author: AuthorProfile,
  partners: PartnerRow[],
  opts: { minScore?: number } = {},
): Array<{ partner: PartnerRow; score: number }> {
  const minScore = opts.minScore ?? 1;
  const authorTokens = topicTokens(
    author.niche,
    ...author.target_audiences,
    ...author.seed_keywords,
    ...author.modifiers,
  );
  return partners
    .filter((p) => p.id !== author.id)
    .filter((p) => p.backlinks_enabled && p.status === "active" && !p.inappropriate_content)
    .map((p) => ({
      partner: p,
      score: scoreOverlap(
        authorTokens,
        topicTokens(
          p.niche,
          ...p.target_audiences,
          ...p.seed_keywords,
          ...p.modifiers,
        ),
      ),
    }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

export async function findGuestPostOpportunities(
  supabase: SupabaseClient<any>,
  authorSiteId: string,
): Promise<GuestPostOpportunity[]> {
  const { data: authorRow } = await supabase
    .from("lx_site")
    .select("id, niche, target_audiences, seed_keywords, modifiers")
    .eq("id", authorSiteId)
    .maybeSingle();
  if (!authorRow) return [];

  const { data: partnerRows, error } = await supabase
    .from("lx_site")
    .select(
      "id, domain, niche, blog_root_url, target_audiences, seed_keywords, modifiers, status, backlinks_enabled, inappropriate_content",
    )
    .eq("backlinks_enabled", true)
    .eq("status", "active")
    .eq("inappropriate_content", false)
    .neq("id", authorSiteId);
  if (error) {
    console.warn("[lx] guest-post partner query failed:", error.message);
    return [];
  }

  // Same relaxed-threshold logic as exchangeMatcher — uses the
  // eligible-article count, not the site count, since one site with
  // many posts is more useful than ten with none.
  const { count: networkSize } = await supabase
    .from("lx_article")
    .select("id, site:lx_site!lx_article_site_id_fkey!inner(backlinks_enabled, status, inappropriate_content)", {
      count: "exact",
      head: true,
    })
    .in("status", ["ready", "published"])
    .eq("site.backlinks_enabled", true)
    .eq("site.status", "active")
    .eq("site.inappropriate_content", false);
  const relaxed = (networkSize ?? 0) < RELAXED_NICHE_THRESHOLD;
  const minScore = relaxed ? 0 : 1;

  const ranked = rankPartners(authorRow as AuthorProfile, (partnerRows ?? []) as PartnerRow[], {
    minScore,
  });
  return ranked.slice(0, MAX_OPPORTUNITIES).map(({ partner, score }) => ({
    partner_site_id: partner.id,
    partner_domain: partner.domain,
    partner_niche: partner.niche,
    partner_blog_root_url: partner.blog_root_url,
    score,
    suggested_topics: suggestTopics(authorRow as AuthorProfile, partner),
  }));
}
