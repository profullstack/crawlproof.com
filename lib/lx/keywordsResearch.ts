// Keyword research pipeline (PRD §6.1, §15).
//
// Inputs: siteId — the site's `master_keywords` (the durable subject list) and
//         `modifiers` (what the site actually does) are the two lists this
//         works from. `niche` backfills the modifiers when that column is empty.
// Outputs: up to 30 new rows in lx_keyword (status='queued'), allocated evenly
//          across every master subject and scheduled across the next ~6 weeks
//          honoring publish_days + daily_article_count.
//
// **Every subject is researched, and none is researched alone.** Both halves
// matter and both were broken. See lib/lx/topicPlan.ts for the failure this
// was written against — nineteen articles about peptide vendors on a payments
// blog — and why the fix is a cross product rather than a bigger slice.
//
// Cost note: the cross queries all go into a *single* keywordIdeas call, which
// accepts 200 seeds. Covering ten subjects properly is therefore cheaper than
// the three separate calls this replaced, not more expensive.
//
// Spend ledger: every DataForSEO call writes a row to lx_dataforseo_usage.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import {
  flattenBuyerJourneyKeywords,
  generateBuyerJourneyKeywordOpportunities,
  type BuyerJourneyClusterType,
  type BuyerJourneyKeywordCandidate,
  type BuyerJourneyKeywordIntent,
  type BuyerJourneyKeywordInput,
} from "./buyerJourneyKeywords";
import { DataForSeoClient, filterOutliers, type DfsKeywordRow } from "./dataforseo";
import { nextPublishAt } from "./schedule";
import {
  allocate,
  anchorTokens,
  crossQueries,
  dropDuplicates,
  isOnNiche,
  ownAnchorTokens,
  resolveMasters,
  resolveModifiers,
  signature,
  stem,
  tokens,
} from "./topicPlan";

type SiteRow = {
  id: string;
  domain: string | null;
  niche: string | null;
  target_audiences: string[];
  description: string | null;
  seed_keywords: string[];
  master_keywords: string[];
  modifiers: string[];
  keywords: string[];
  competitors: string[];
  tone: string | null;
  publish_days: number[];
  publish_hour: number;
  daily_article_count: number;
};

const TARGET_KEYWORDS = 30;
const MIN_VOLUME = 50;
const MIN_BUYER_JOURNEY_VOLUME = 10;
const MIN_WORDS = 2;
const IDEAS_LIMIT = 600;
const MAX_BUYER_JOURNEY_VOLUME_LOOKUP = 160;

/**
 * Cross depth per subject.
 *
 * Three narrowing terms per subject: enough that a subject yields more than a
 * single phrasing, few enough that ten subjects still fit one API call with
 * room for the seed list to grow.
 */
const CROSS_PER_MASTER = 3;

/**
 * A candidate with the subject it belongs to.
 *
 * `fromCross` marks the locally-built subject x modifier constructions. They
 * are excellent *seeds* — that is their real job — and mediocre *articles*, so
 * they are tracked separately and only published as a last resort.
 */
type Candidate = { row: DfsKeywordRow; master: string; fromCross?: boolean };

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

type KeywordBoost = {
  priority: number;
  intent: BuyerJourneyKeywordIntent;
  clusterType: BuyerJourneyClusterType;
};

/**
 * Which subject a candidate belongs to.
 *
 * Longest match wins, so a site covering both "crypto" and "cryptocurrency"
 * attributes "cryptocurrency merchant account" to the more specific of the
 * two rather than to whichever happens to sort first. Returns null when no
 * subject claims it — the caller drops those, which is the same verdict the
 * niche gate would reach a moment later.
 */
function attribute(keyword: string, masters: string[]): string | null {
  let best: string | null = null;
  let bestLen = 0;
  // Stemmed on both sides, so attribution and the gate agree about what
  // "promo codes" and "promo code" are. They disagreed before, and a keyword
  // attributed to a subject the gate then could not match was dropped for a
  // reason nobody would have guessed from the strings.
  const candidate = new Set(tokens(keyword).map(stem));
  for (const master of masters) {
    const masterTokens = tokens(master).map(stem);
    if (masterTokens.length === 0) continue;
    const hit = masterTokens.filter((t) => candidate.has(t));
    if (hit.length === 0) continue;
    const len = hit.join("").length;
    if (len > bestLen) {
      bestLen = len;
      best = master;
    }
  }
  return best;
}

function rankKeywords(
  rows: DfsKeywordRow[],
  boosts = new Map<string, KeywordBoost>(),
): DfsKeywordRow[] {
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
    const boost = boosts.get(r.keyword.toLowerCase());
    const priorityBoost = boost ? boost.priority * 0.14 : 0;
    const intentBoost = boost && ["commercial", "transactional", "local"].includes(boost.intent)
      ? 0.12
      : 0;
    const opennessBoost = boost && [
      "alternative_solution",
      "comparison",
      "commercial_openness",
      "objection_or_risk",
      "substitute",
    ].includes(boost.clusterType)
      ? 0.12
      : 0;
    const score =
      -(rankPenalty * 0.6) +
      logVol * 0.04 +
      priorityBoost +
      intentBoost +
      opennessBoost; // volume still matters, but buyer-journey openness can outrank generic variants.
    return { row: r, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}

function buildBuyerJourneyInput(
  site: SiteRow,
  masters: string[],
  modifiers: string[],
): BuyerJourneyKeywordInput {
  const brand = site.domain?.replace(/^www\./, "") || site.niche || "the website";
  const offer = [site.niche, site.description]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join(" — ")
    .slice(0, 900);
  return {
    // Every subject, not just the first one. The old code passed
    // `seeds[0]` here and `seeds.slice(1, 8)` from an already-truncated
    // list, which is how one subject came to own the entire model run.
    seedQuery: masters.join(", "),
    additionalSeeds: modifiers.slice(0, 8),
    offer: offer || brand,
    audience: site.target_audiences?.join(", ") || "the site's target customers",
    brand,
    geography: "United States",
    industry: site.niche || "not specified",
    competitors: site.competitors ?? [],
    tone: site.tone || "helpful, educational, non-pushy",
  };
}

function rowFromCandidate(
  candidate: BuyerJourneyKeywordCandidate,
  metrics?: DfsKeywordRow,
): DfsKeywordRow {
  return {
    keyword: candidate.keyword,
    search_volume: metrics?.search_volume ?? null,
    competition: metrics?.competition ?? null,
    competition_index: metrics?.competition_index ?? null,
    cpc: metrics?.cpc ?? null,
    low_top_of_page_bid: metrics?.low_top_of_page_bid ?? null,
    high_top_of_page_bid: metrics?.high_top_of_page_bid ?? null,
    monthly_searches: metrics?.monthly_searches ?? null,
  };
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

/**
 * Interleave per-subject picks so the schedule alternates topics.
 *
 * Allocation decides *how many* rows each subject gets; this decides the order
 * they are scheduled in, and the two are separate concerns. A fair allocation
 * emitted subject-by-subject would still publish six consecutive peptide posts
 * and then six consecutive casino ones — fair over a quarter, and visibly
 * spammy over a fortnight. Round-robining the emission is what makes the fix
 * legible to a reader of the blog rather than only to a reader of the database.
 */
function interleave(byMaster: Map<string, Candidate[]>): Candidate[] {
  const queues = Array.from(byMaster.values()).map((c) => [...c]);
  const out: Candidate[] = [];
  let live = true;
  while (live) {
    live = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (next) {
        out.push(next);
        live = true;
      }
    }
  }
  return out;
}

export type KeywordResearchResult = {
  ok: boolean;
  inserted: number;
  apiCost: number;
  /** Rows allocated per subject — surfaced so a skewed queue is visible. */
  perMaster?: Record<string, number>;
  /**
   * True when nothing researched survived and the run fell back to
   * constructed subject x modifier topics. A degraded result, not a failure —
   * reported rather than swallowed, because a site sitting on this for weeks
   * means its upstreams or its modifiers need attention.
   */
  usedCrossFloor?: boolean;
  error?: string;
};

export async function researchKeywords(
  siteId: string,
  deps: {
    supabase: SupabaseClient<any>;
    dfs: DataForSeoClient;
    openai?: OpenAI | null;
    anthropic?: Anthropic | null;
    backendAiProvider?: string;
  },
): Promise<KeywordResearchResult> {
  const { supabase, dfs } = deps;

  const { data: site } = await supabase
    .from("lx_site")
    .select(
      "id, domain, niche, target_audiences, description, seed_keywords, master_keywords, modifiers, keywords, competitors, tone, publish_days, publish_hour, daily_article_count",
    )
    .eq("id", siteId)
    .maybeSingle<SiteRow>();
  if (!site) {
    return { ok: false, inserted: 0, apiCost: 0, error: "site not found" };
  }

  const masters = resolveMasters(site);
  // Masters are passed through so the derived terms can subtract them: an
  // anchor word that is also a subject word lets a candidate satisfy both
  // halves of the gate with one token. See anchorTokens.
  const modifiers = resolveModifiers(site, masters);
  const anchors = anchorTokens(site, masters);
  // Site-supplied anchors only. A partial match on a multi-word subject may
  // not be rescued by the generic vocabulary — see isOnNiche.
  const ownAnchors = ownAnchorTokens(site, masters);

  if (masters.length === 0) {
    return {
      ok: false,
      inserted: 0,
      apiCost: 0,
      error: "add master keywords (the subjects this blog covers) first",
    };
  }
  // Refusing here rather than falling back to an unanchored expansion is the
  // point. An anchorless run is exactly the run that produced the vendor
  // articles, so it must be an error the operator sees and fixes, not a
  // degraded mode that quietly publishes.
  if (anchors.size === 0) {
    return {
      ok: false,
      inserted: 0,
      apiCost: 0,
      error:
        "set a niche or modifiers first — keywords are only researched crossed with what this site does, never on their own",
    };
  }

  // Existing rows serve two purposes: the duplicate fingerprints, and the
  // per-subject coverage the allocator balances against. Failed rows are
  // intentionally excluded from the duplicate set — an upstream outage should
  // not permanently poison a topic — but they still count toward coverage, so
  // a subject that keeps failing does not monopolise every top-up.
  const { data: existingRows } = await supabase
    .from("lx_keyword")
    .select("keyword, status, master_keyword")
    .eq("site_id", site.id);

  const publishedSignatures = new Set<string>();
  const coverage = new Map<string, number>();
  for (const row of (existingRows ?? []) as Array<{
    keyword: string;
    status: string;
    master_keyword: string | null;
  }>) {
    if (row.status !== "failed") {
      const sig = signature(row.keyword);
      if (sig) publishedSignatures.add(sig);
    }
    // Attribute legacy rows (written before provenance existed) so the
    // allocator sees the real history rather than treating a blog with
    // twenty-three peptide posts as having no coverage at all. Without this
    // the balancing would take a full cycle to notice the existing skew.
    const master = row.master_keyword ?? attribute(row.keyword, masters);
    if (master) {
      const key = master.toLowerCase();
      coverage.set(key, (coverage.get(key) ?? 0) + 1);
    }
  }

  const allocation = allocate(masters, coverage, TARGET_KEYWORDS);

  // ------------------------------------------------------------------
  // Candidate sources. All three are gated identically; they differ only
  // in how they are obtained and how likely they are to be unavailable.
  // ------------------------------------------------------------------
  const candidates: Candidate[] = [];
  const buyerJourneyBoosts = new Map<string, KeywordBoost>();
  let totalCost = 0;
  const sourceErrors: string[] = [];

  // Source 0 — the floor. Subject × modifier, built locally from two columns
  // the operator controls. No network, no failure mode, always on-niche by
  // construction. Everything below is an improvement on this, never a
  // prerequisite for it.
  const crosses = crossQueries(masters, modifiers, CROSS_PER_MASTER);
  for (const { master, query } of crosses) {
    candidates.push({
      fromCross: true,
      row: {
        keyword: query,
        search_volume: null,
        competition: null,
        competition_index: null,
        cpc: null,
        low_top_of_page_bid: null,
        high_top_of_page_bid: null,
        monthly_searches: null,
      },
      master,
    });
  }

  // Source 1 — hand-saved long-tail from the settings page.
  for (const parsed of (site.keywords ?? []).map(parseStoredKeyword)) {
    if (!parsed) continue;
    const master = attribute(parsed.keyword, masters);
    if (master) candidates.push({ row: parsed, master });
  }

  // Source 2 — the buyer-journey model, now seeded with every subject.
  if (deps.openai || deps.anthropic) {
    try {
      const buyerJourney = await generateBuyerJourneyKeywordOpportunities(
        buildBuyerJourneyInput(site, masters, modifiers),
        {
          openai: deps.openai,
          anthropic: deps.anthropic,
          backendAiProvider: deps.backendAiProvider,
        },
      );
      const flattened = flattenBuyerJourneyKeywords(
        buyerJourney.output,
        MAX_BUYER_JOURNEY_VOLUME_LOOKUP,
      );
      const volumeKeywords = flattened.map((c) => c.keyword);
      const volume = volumeKeywords.length > 0
        ? await dfs.searchVolume(volumeKeywords)
        : { rows: [], cost: 0, taskId: null };
      totalCost += volume.cost;
      if (volume.cost > 0 || volume.taskId) {
        await supabase.from("lx_dataforseo_usage").insert({
          task_id: volume.taskId,
          endpoint: "search_volume/live",
          cost: volume.cost,
          site_id: site.id,
        });
      }

      const metricsByKeyword = new Map(
        volume.rows.map((r) => [r.keyword.toLowerCase(), r]),
      );
      for (const candidate of flattened) {
        const metrics = metricsByKeyword.get(candidate.keyword.toLowerCase());
        const volumeValue = metrics?.search_volume ?? 0;
        if (volumeValue < MIN_BUYER_JOURNEY_VOLUME && candidate.priority < 4) continue;
        const master = attribute(candidate.keyword, masters);
        if (!master) continue;
        candidates.push({ row: rowFromCandidate(candidate, metrics), master });
        buyerJourneyBoosts.set(candidate.keyword.toLowerCase(), {
          priority: candidate.priority,
          intent: candidate.intent,
          clusterType: candidate.clusterType,
        });
      }
    } catch (err) {
      sourceErrors.push(
        `buyer-journey model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Source 3 — DataForSEO expansion of the CROSSED phrases.
  //
  // One call carrying every cross, because keywordIdeas accepts 200 seeds.
  // The bare subject is never sent: "peptide" on its own is what returned
  // "skye peptides" and "pure peptide labs", and no downstream filter can
  // reliably tell those from a keyword worth writing about.
  if (crosses.length > 0) {
    try {
      const result = await dfs.keywordIdeas(
        crosses.map((c) => c.query),
        {
          limit: IDEAS_LIMIT,
          minVolume: MIN_VOLUME,
          minWords: MIN_WORDS,
          closelyVariants: false,
        },
      );
      totalCost += result.cost;
      await supabase.from("lx_dataforseo_usage").insert({
        task_id: result.taskId,
        endpoint: "keyword_ideas/live",
        cost: result.cost,
        site_id: site.id,
      });
      for (const row of result.rows) {
        const master = attribute(row.keyword, masters);
        if (master) candidates.push({ row, master });
      }
    } catch (err) {
      sourceErrors.push(
        `keyword ideas: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Gate, rank, allocate.
  // ------------------------------------------------------------------
  const onNiche = candidates.filter((c) =>
    isOnNiche(c.row.keyword, c.master, anchors, ownAnchors),
  );

  // Volume filtering applies only to what came back from an API with a volume
  // attached. The locally-built crosses have no volume by construction and
  // must not be discarded for it — they are the floor that keeps the queue
  // from emptying when everything upstream is unavailable.
  const withVolume = onNiche.filter((c) => c.row.search_volume !== null);
  const withoutVolume = onNiche.filter((c) => c.row.search_volume === null);
  const volumeKept = filterOutliers(withVolume.map((c) => c.row)).filter((r) => {
    const boost = buyerJourneyBoosts.get(r.keyword.toLowerCase());
    if (boost && boost.priority >= 4) return true;
    return (r.search_volume ?? 0) >= MIN_VOLUME;
  });
  const volumeKeptKeys = new Set(volumeKept.map((r) => r.keyword.toLowerCase()));

  const ranked = rankKeywords(volumeKept, buyerJourneyBoosts);
  const rankIndex = new Map(ranked.map((r, i) => [r.keyword.toLowerCase(), i]));

  const survivors = [
    ...withVolume
      .filter((c) => volumeKeptKeys.has(c.row.keyword.toLowerCase()))
      .sort(
        (a, b) =>
          (rankIndex.get(a.row.keyword.toLowerCase()) ?? Infinity) -
          (rankIndex.get(b.row.keyword.toLowerCase()) ?? Infinity),
      ),
    // Crosses last within each subject: a real long-tail phrase with measured
    // demand is a better article than a two-word construction, but the
    // construction is a better article than nothing.
    ...withoutVolume,
  ];

  const deduped = dropDuplicates(
    survivors.map((c) => ({ ...c, keyword: c.row.keyword })),
    publishedSignatures,
  );

  /**
   * Take each subject's allocated share, then interleave so the published
   * sequence alternates subjects rather than running one to exhaustion.
   */
  function select(pool: Candidate[]): Candidate[] {
    const byMaster = new Map<string, Candidate[]>();
    for (const master of masters) byMaster.set(master, []);
    for (const candidate of pool) {
      const bucket = byMaster.get(candidate.master);
      if (!bucket) continue;
      if (bucket.length >= (allocation.get(candidate.master) ?? 0)) continue;
      bucket.push(candidate);
    }
    // Subjects that could not fill their share hand it back, so a subject
    // with no available candidates costs the run coverage rather than volume.
    return interleave(byMaster).slice(0, TARGET_KEYWORDS);
  }

  // The crosses are held back from the normal pass.
  //
  // They were being used as per-subject filler, and the first production run
  // showed what that publishes: "saving money pricing", "deals platform",
  // "coordination d0rz", "ai content loop". On-niche, gate-passing, and not
  // article topics anybody would search for — bl0ggers' niche is
  // "human-in-the-loop AI publishing", so its derived modifiers are literally
  // "human" and "loop", and crossing a subject with those yields nonsense.
  //
  // Their real value is upstream: as DataForSEO seeds they are what turns
  // "peptide" into "peptide merchant account". So they still seed every
  // expansion — they just no longer get published on the strength of being
  // grammatically adjacent to the niche.
  let chosen = select(deduped.filter((c) => !c.fromCross));

  // Last resort, and site-level rather than per-subject: only when the entire
  // run would otherwise insert nothing does the constructed floor get used.
  // That preserves "a blog with every upstream down still publishes" without
  // letting constructions pad an otherwise healthy run.
  let usedCrossFloor = false;
  if (chosen.length === 0) {
    chosen = select(deduped);
    usedCrossFloor = chosen.length > 0;
    if (usedCrossFloor) {
      console.warn(
        `[lx] ${site.domain}: no researched keywords survived; falling back to ${chosen.length} constructed subject x modifier topics`,
      );
    }
  }

  if (chosen.length === 0) {
    const details = sourceErrors.length > 0
      ? ` Source errors: ${sourceErrors.join("; ")}`
      : "";
    return {
      ok: false,
      inserted: 0,
      apiCost: totalCost,
      error:
        "No new keyword candidates found. Every candidate was already published or off-niche; add master keywords or modifiers and try again." +
        details,
    };
  }

  // The cross-tenant lx_keyword_metrics cache is intentionally left
  // unpopulated in v1 — its read path doesn't exist yet, and onConflict
  // upserts can't target the (lower(keyword), region) expression index
  // without first reshaping it. We re-introduce it when keyword overlap
  // across customers becomes measurable.

  const slots = scheduleKeywords(
    chosen.length,
    site.publish_days,
    site.publish_hour,
    site.daily_article_count,
  );

  const insertRows = chosen.map((c, i) => ({
    site_id: site.id,
    keyword: c.row.keyword,
    master_keyword: c.master,
    scheduled_for: slots[i]?.toISOString().slice(0, 10) ??
      new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10),
    status: "queued",
    source: "auto",
    search_volume: c.row.search_volume,
    cpc_usd: c.row.cpc,
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

  const perMaster: Record<string, number> = {};
  for (const row of insertRows) {
    perMaster[row.master_keyword] = (perMaster[row.master_keyword] ?? 0) + 1;
  }

  return {
    ok: true,
    inserted: insertRows.length,
    apiCost: totalCost,
    perMaster,
    usedCrossFloor,
  };
}
