"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { detectSitemapUrl } from "@/lib/lx/sitemap";
import type { DfsKeywordRow } from "@/lib/lx/dataforseo";
import { nextPublishAt } from "@/lib/lx/schedule";
import {
  enqueueSitemapCrawl,
  enqueueArticleGenerate,
  enqueueArticleDeliver,
} from "@/lib/lx/workerClient";
import { setCurrentSite, getCurrentSite } from "@/lib/lx/currentSite";
import {
  discoverBlogUrls,
  enrichBlogProfile,
  type DiscoveredUrls,
  type EnrichmentResult,
} from "@/lib/lx/detectBlog";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

const MAX = {
  domain: 253,
  url: 2048,
  niche: 120,
  audience: 80,
  audiences: 6,
  description: 2000,
  webhookSecret: 512,
  keyword: 60,
  keywords: 15,
  seoTitle: 70,
  seoDescription: 160,
  tone: 120,
  competitor: 120,
  competitors: 5,
};

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

function normalizeDomain(input: string): string | null {
  const allowed = isAllowedTargetUrl(input);
  if (!allowed.ok) return null;
  try {
    return new URL(allowed.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function defaultBlogRoot(domain: string): string {
  return `https://${domain}/blog`;
}

function isValidHttpsUrl(input: string, maxLen = MAX.url): boolean {
  if (!input || input.length > maxLen) return false;
  try {
    const u = new URL(input);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// Parse "audience a, audience b" into a clean array.
function parseAudiences(input: string): string[] {
  return clean(input, MAX.audiences * (MAX.audience + 2))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX.audiences)
    .map((s) => s.slice(0, MAX.audience));
}

function parseList(
  input: string,
  maxItems: number,
  itemMax: number,
): string[] {
  // Accept either newline- or comma-separated for free-text list fields
  // (competitors, etc.). Keywords use parseKeywordRows() instead — they
  // store one CSV row per line so commas inside a row are preserved.
  return clean(input, maxItems * (itemMax + 2))
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((s) => s.slice(0, itemMax));
}

// Find an existing project row for (owner, domain), or create one.
// Centralizes the projects+lx_site unification: any code path that
// mints an lx_site row first goes through this to attach to (or
// create) the canonical projects row.
async function findOrCreateProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  domain: string,
  name: string | null,
): Promise<{ id: string } | { error: string }> {
  const url = `https://${domain}`;
  const { data: existing } = await supabase
    .from("projects")
    .select("id")
    .eq("owner_id", userId)
    .eq("url", url)
    .maybeSingle();
  if (existing) return { id: existing.id as string };

  const { data: created, error } = await supabase
    .from("projects")
    .insert({
      owner_id: userId,
      name: name ?? domain,
      url,
      schedule: "off",
    })
    .select("id")
    .single();
  if (error || !created) {
    return { error: error?.message ?? "Could not create project." };
  }
  return { id: created.id as string };
}

// Keywords textarea: one CSV row per line, `<keyword>,<monthly_volume>`.
// We store the row verbatim so the volume hint persists; downstream
// consumers split on the first comma to recover just the keyword.
function parseKeywordRows(input: string, maxItems: number, itemMax: number): string[] {
  return clean(input, maxItems * (itemMax + 2))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((s) => s.slice(0, itemMax));
}

// ------------------------------------------------------------
// detectSitemap — legacy single-shot sitemap probe, used by the
// "Detect" button next to the sitemap field for manual re-runs.
// ------------------------------------------------------------
export async function detectSitemap(
  domainInput: string,
): Promise<Ok<{ sitemapUrl: string | null }> | Err> {
  const domain = normalizeDomain(domainInput);
  if (!domain) return { ok: false, error: "Enter a valid domain." };
  const sitemapUrl = await detectSitemapUrl(domain);
  return { ok: true, sitemapUrl };
}

// ------------------------------------------------------------
// discoverFromHomepage — phase 1 of the new wizard. Pass any URL
// (homepage or blog), get back the trio of URLs we need.
// ------------------------------------------------------------
export async function discoverFromHomepage(
  rawUrl: string,
): Promise<Ok<{ urls: DiscoveredUrls }> | Err> {
  const res = await discoverBlogUrls(rawUrl);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, urls: res.urls };
}

// ------------------------------------------------------------
// createSite — minimal "add this domain so I can scan it" path.
//
// Distinct from createOrUpdateSite: this one stores ONLY the domain
// (and an optional display name). No blog URL, no sitemap, no
// autoblog webhook — all those fields stay NULL, the autoblog cron
// already filters `where webhook_url is not null`, so the site
// simply doesn't participate in autoblog/backlinks until the user
// opts in via /autoblog/setup.
//
// Sets the new row as the current site so the picker reflects it
// without an extra click.
// ------------------------------------------------------------
export async function createSite(input: {
  domain: string;
  name?: string;
}): Promise<Ok<{ siteId: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const domain = normalizeDomain(input.domain);
  if (!domain) return { ok: false, error: "Enter a valid domain." };

  const name = clean(input.name, MAX.niche) || null;

  // Find or create the canonical project for this (owner, domain).
  // lx_site is now 1:1 with projects, so we attach to the existing
  // project if there is one — even if it predated autoblog.
  const proj = await findOrCreateProject(supabase, user.id, domain, name);
  if ("error" in proj) return { ok: false, error: proj.error };

  // Reject duplicates per-project — same domain already has an
  // lx_site shell (1:1 constraint would catch this, but a clean
  // error beats a Postgres unique-violation).
  const { data: existing } = await supabase
    .from("lx_site")
    .select("id")
    .eq("project_id", proj.id)
    .maybeSingle();
  if (existing) {
    await setCurrentSite(proj.id);
    revalidatePath("/dashboard");
    return { ok: true, siteId: existing.id as string };
  }

  const { data: inserted, error } = await supabase
    .from("lx_site")
    .insert({
      user_id: user.id,
      project_id: proj.id,
      domain,
      url: `https://${domain}`,
      name,
      // Everything autoblog-shaped stays null until the user
      // explicitly configures it on /autoblog/setup.
      blog_root_url: null,
      sitemap_url: null,
      webhook_url: null,
      webhook_secret: null,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    return { ok: false, error: error?.message ?? "Could not add site." };
  }

  await setCurrentSite(proj.id);
  revalidatePath("/dashboard");
  return { ok: true, siteId: inserted.id as string };
}

// ------------------------------------------------------------
// enrichFromUrls — phase 2 of the new wizard. With confirmed URLs
// (auto-found or user-supplied), scrape the blog + feed and ask
// the configured backend text model to extract niche / audiences / description.
// ------------------------------------------------------------
export async function enrichFromUrls(input: {
  blogUrl: string;
  feedUrl: string | null;
  sitemapUrl: string | null;
}): Promise<Ok<{ profile: EnrichmentResult }> | Err> {
  if (!isValidHttpsUrl(input.blogUrl)) {
    return { ok: false, error: "Blog URL must be a valid http(s) URL." };
  }
  if (input.feedUrl && !isValidHttpsUrl(input.feedUrl)) {
    return { ok: false, error: "Feed URL must be a valid http(s) URL." };
  }
  const res = await enrichBlogProfile({
    blogUrl: input.blogUrl,
    feedUrl: input.feedUrl,
    sitemapUrl: input.sitemapUrl,
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, profile: res.profile };
}

// ------------------------------------------------------------
// createOrUpdateSite — idempotent upsert keyed on the user (v1: 1 site/user).
//
// Webhook secret is receiver-owned: the user generates a bearer token
// on their receiver site (e.g. coinpayportal /admin), pastes it here,
// and we store it verbatim and send it as Authorization: Bearer on
// each webhook call. Pasting a new value rotates it.
// ------------------------------------------------------------
export type SiteInput = {
  // Optional: when set, update that specific site (multi-site agency
  // model). When unset, create a new lx_site row.
  siteId?: string;
  // The project this autoblog config belongs to. When set we look up
  // the project directly by id (verifying ownership) instead of
  // matching on domain — fixes the bug where saving from
  // /projects/A/autoblog/setup with a domain that matched some other
  // project would attach the lx_site to that other project.
  projectId?: string;
  domain: string;
  blogRootUrl: string;
  sitemapUrl: string;
  niche: string;
  targetAudiences: string;
  description: string;
  // Comma-separated 1-3 word head terms for DataForSEO expansion.
  seedKeywords: string;
  // Comma-separated tail terms ("payments", "merchant account") that the
  // form crosses with seedKeywords client-side to build the long-tail list.
  modifiers: string;
  // When true, Refetch flows skip overwriting the keywords text[]. Used
  // after a hand-curated build via seeds × modifiers.
  preserveKeywords: boolean;
  // Comma-separated. parseList() into a text[].
  keywords: string;
  seoTitle: string;
  seoDescription: string;
  tone: string;
  // Comma-separated. parseList() into a text[].
  competitors: string;
  webhookUrl: string;
  webhookSecret: string;
  dailyArticleCount: number;
  publishDays: number[];
  publishHour: number;
  internalLinksPerArticle: number;
  // Backlink-exchange opt-in. Stored verbatim; the matcher + verifier
  // (Link Exchange phase) ships separately.
  backlinksEnabled?: boolean;
  externalLinksPerArticle?: number;
  // Autoblog hero/banner image style. See BANNER_STYLES in
  // lib/lx/articleGen.ts. Defaults to 'editorial'.
  bannerStyle?: string;
};

export async function createOrUpdateSite(
  input: SiteInput,
): Promise<Ok<{ siteId: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const domain = normalizeDomain(input.domain);
  if (!domain) return { ok: false, error: "Enter a valid domain." };

  const blogRootUrl = clean(input.blogRootUrl, MAX.url) || defaultBlogRoot(domain);
  if (!isValidHttpsUrl(blogRootUrl)) {
    return { ok: false, error: "Blog root URL must be a valid http(s) URL." };
  }

  const sitemapUrl = clean(input.sitemapUrl, MAX.url);
  if (!isValidHttpsUrl(sitemapUrl)) {
    return { ok: false, error: "Sitemap URL must be a valid http(s) URL." };
  }

  const webhookUrl = clean(input.webhookUrl, MAX.url);
  if (!isValidHttpsUrl(webhookUrl)) {
    return { ok: false, error: "Webhook URL must be a valid http(s) URL." };
  }

  const webhookSecret = clean(input.webhookSecret, MAX.webhookSecret);
  if (webhookSecret.length < 16) {
    return {
      ok: false,
      error: "Paste the bearer token generated by your receiver site (min 16 chars).",
    };
  }

  const niche = clean(input.niche, MAX.niche) || null;
  const description = clean(input.description, MAX.description);
  const audiences = parseAudiences(input.targetAudiences);
  const seedKeywords = parseList(input.seedKeywords, 50, 40);
  const modifiers = parseList(input.modifiers, 20, 40);
  const preserveKeywords = !!input.preserveKeywords;
  // Keywords use parseKeywordRows so each row keeps its `,<volume>` hint.
  // Allow up to ~80 chars per row to fit "keyword phrase here,12345".
  const keywords = parseKeywordRows(input.keywords, MAX.keywords, MAX.keyword + 20);
  const seoTitle = clean(input.seoTitle, MAX.seoTitle) || null;
  const seoDescription = clean(input.seoDescription, MAX.seoDescription) || null;
  const tone = clean(input.tone, MAX.tone) || null;
  const competitors = parseList(input.competitors, MAX.competitors, MAX.competitor);

  const dailyArticleCount = Math.max(1, Math.min(5, Math.floor(input.dailyArticleCount || 1)));
  const publishHour = Math.max(0, Math.min(23, Math.floor(input.publishHour ?? 9)));
  const internalLinks = Math.max(0, Math.min(8, Math.floor(input.internalLinksPerArticle ?? 3)));
  const backlinksEnabled = !!input.backlinksEnabled;
  const externalLinks = Math.max(0, Math.min(5, Math.floor(input.externalLinksPerArticle ?? 3)));
  const BANNER_STYLE_IDS = ["editorial", "hype", "concept", "tech", "bold_type"];
  const bannerStyle = BANNER_STYLE_IDS.includes(input.bannerStyle ?? "")
    ? (input.bannerStyle as string)
    : "editorial";
  const publishDays = Array.from(
    new Set(
      (input.publishDays ?? [1, 2, 3, 4, 5])
        .map((n) => Math.floor(n))
        .filter((n) => n >= 1 && n <= 7),
    ),
  ).sort((a, b) => a - b);
  if (publishDays.length === 0) {
    return { ok: false, error: "Pick at least one publishing day." };
  }

  const nextAt = nextPublishAt(publishDays, publishHour);

  // Resolve the project. When projectId is given (called from
  // /projects/[id]/autoblog/setup) we use that directly and verify
  // ownership — the domain field becomes pure metadata for the lx_site
  // row, not a project-matching key. Without projectId, fall back to
  // the old find-or-create-by-domain path so the legacy entry points
  // (e.g. the wizard before a project exists) keep working.
  let proj: { id: string };
  if (input.projectId) {
    const { data: owned } = await supabase
      .from("projects")
      .select("id")
      .eq("id", input.projectId)
      .maybeSingle();
    if (!owned) return { ok: false, error: "Project not found." };
    proj = { id: owned.id as string };
  } else {
    const found = await findOrCreateProject(supabase, user.id, domain, niche);
    if ("error" in found) return { ok: false, error: found.error };
    proj = found;
  }

  // The 1:1 lx_site<-project constraint means re-saving for an existing
  // project must go through the update path. Catch the race: if a
  // lx_site already exists for this project but the caller didn't pass
  // siteId, treat it as an update.
  const { data: existingByProject } = await supabase
    .from("lx_site")
    .select("id")
    .eq("project_id", proj.id)
    .maybeSingle();

  if (existingByProject) {
    const { error } = await supabase
      .from("lx_site")
      .update({
        domain,
        url: `https://${domain}`,
        blog_root_url: blogRootUrl,
        sitemap_url: sitemapUrl,
        niche,
        target_audiences: audiences,
        description,
        seed_keywords: seedKeywords,
        modifiers,
        preserve_keywords: preserveKeywords,
        keywords,
        seo_title: seoTitle,
        seo_description: seoDescription,
        tone,
        competitors,
        webhook_url: webhookUrl,
        webhook_secret: webhookSecret,
        daily_article_count: dailyArticleCount,
        publish_days: publishDays,
        publish_hour: publishHour,
        internal_links_per_article: internalLinks,
        backlinks_enabled: backlinksEnabled,
        external_links_per_article: externalLinks,
        banner_style: bannerStyle,
        next_publish_at: nextAt?.toISOString() ?? null,
      })
      .eq("id", existingByProject.id);
    if (error) return { ok: false, error: error.message };
    await enqueueSitemapCrawl(existingByProject.id as string);
    await setCurrentSite(proj.id);
    revalidatePath("/autoblog");
    revalidatePath(`/projects/${proj.id}/autoblog`, "layout");
    return { ok: true, siteId: existingByProject.id as string };
  }

  // Check for domain conflict before attempting insert so the user gets
  // a readable error instead of a raw Postgres constraint violation.
  // Use the service client so RLS doesn't hide rows owned by other
  // users (or orphaned rows with null user_id), which would let the
  // INSERT proceed and crash with a raw unique-constraint error.
  const svcForConflict = serviceClient();
  const { data: domainConflict } = await svcForConflict
    .from("lx_site")
    .select("id, project_id")
    .eq("domain", domain)
    .maybeSingle();
  if (domainConflict) {
    if (domainConflict.project_id === proj.id) {
      // Race: existingByProject lookup missed it — just update.
      const { error: raceErr } = await supabase
        .from("lx_site")
        .update({
          domain,
          url: `https://${domain}`,
          blog_root_url: blogRootUrl,
          sitemap_url: sitemapUrl,
          niche,
          target_audiences: audiences,
          description,
          seed_keywords: seedKeywords,
          modifiers,
          preserve_keywords: preserveKeywords,
          keywords,
          seo_title: seoTitle,
          seo_description: seoDescription,
          tone,
          competitors,
          webhook_url: webhookUrl,
          webhook_secret: webhookSecret,
          daily_article_count: dailyArticleCount,
          publish_days: publishDays,
          publish_hour: publishHour,
          internal_links_per_article: internalLinks,
          backlinks_enabled: backlinksEnabled,
          external_links_per_article: externalLinks,
          banner_style: bannerStyle,
          next_publish_at: nextAt?.toISOString() ?? null,
        })
        .eq("id", domainConflict.id);
      if (raceErr) return { ok: false, error: raceErr.message };
      await enqueueSitemapCrawl(domainConflict.id as string);
      await setCurrentSite(proj.id);
      revalidatePath("/autoblog");
      revalidatePath(`/projects/${proj.id}/autoblog`, "layout");
      return { ok: true, siteId: domainConflict.id as string };
    }
    return {
      ok: false,
      error: `The domain "${domain}" is already enrolled in another autoblog. Delete that autoblog first, then try again.`,
    };
  }

  const { data: inserted, error } = await supabase
    .from("lx_site")
    .insert({
      user_id: user.id,
      project_id: proj.id,
      domain,
      url: `https://${domain}`,
      blog_root_url: blogRootUrl,
      sitemap_url: sitemapUrl,
      niche,
      target_audiences: audiences,
      description,
      seed_keywords: seedKeywords,
      modifiers,
      preserve_keywords: preserveKeywords,
      keywords,
      seo_title: seoTitle,
      seo_description: seoDescription,
      tone,
      competitors,
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
      daily_article_count: dailyArticleCount,
      publish_days: publishDays,
      publish_hour: publishHour,
      internal_links_per_article: internalLinks,
      backlinks_enabled: backlinksEnabled,
      external_links_per_article: externalLinks,
      banner_style: bannerStyle,
      next_publish_at: nextAt?.toISOString() ?? null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    // If we still hit the domain unique constraint despite our pre-check
    // (race between two concurrent saves), re-fetch and update instead.
    if (error?.code === "23505" && error.message.includes("lx_site_domain_unique")) {
      const { data: raceRow } = await svcForConflict
        .from("lx_site")
        .select("id")
        .eq("domain", domain)
        .maybeSingle();
      if (raceRow) {
        const { error: raceErr } = await supabase
          .from("lx_site")
          .update({ project_id: proj.id })
          .eq("id", raceRow.id);
        if (!raceErr) {
          await enqueueSitemapCrawl(raceRow.id as string);
          await setCurrentSite(proj.id);
          revalidatePath("/autoblog");
          revalidatePath(`/projects/${proj.id}/autoblog`, "layout");
          return { ok: true, siteId: raceRow.id as string };
        }
      }
      return { ok: false, error: `The domain "${domain}" is already registered. Delete the existing autoblog first.` };
    }
    return { ok: false, error: error?.message ?? "Could not save site." };
  }

  await enqueueSitemapCrawl(inserted.id);
  await setCurrentSite(proj.id);
  revalidatePath("/autoblog");
  revalidatePath(`/projects/${proj.id}/autoblog`, "layout");
  return { ok: true, siteId: inserted.id };
}

// ------------------------------------------------------------
// suggestLongTailKeywords — DataForSEO Labs keyword_ideas expansion.
//
// Takes BROAD head terms (the seed_keywords the backend model generates
// during enrichment) and fans them out into hundreds of related
// long-tail phrases with monthly volumes. The form expects a fat
// keyword list — one blog targets dozens of phrases, not 5-15 —
// so we ask DFS for up to MAX_RESULTS per call.
//
// Filters pushed server-side: search_volume ≥ MIN_VOLUME,
// keyword_difficulty ≤ 80. Word-count filter is applied client-side
// in the SDK after the fact (Labs `filters` doesn't expose
// keyword_properties.word_count consistently across plans).
// ------------------------------------------------------------
export type KeywordSuggestion = {
  keyword: string;
  searchVolume: number;
  cpcUsd: number | null;
  competition: "LOW" | "MEDIUM" | "HIGH" | null;
};

const MIN_VOLUME = 100;
const MIN_WORDS = 2;
const PER_SEED_LIMIT = 200;
const TOTAL_RESULT_CAP = 300;
// Common short words that shouldn't count as a relevance match — a keyword
// matching only "for", "the" etc. would let off-niche junk slip through.
const SEED_TOKEN_STOPLIST = new Set([
  "the","and","for","with","you","your","that","this","from","into","over",
  "but","not","are","was","were","has","had","have","its","off","out","its",
  "all","any","new","get","how","why","what","who","best","top",
]);

export async function suggestLongTailKeywords(
  seeds: string[],
): Promise<
  Ok<{ suggestions: KeywordSuggestion[]; tier: string }> | Err
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Seeds are short head terms ("web security", not full sentences).
  // Trim, lowercase, dedupe, cap at 20 (Labs accepts up to 200 but
  // 20 already produces hundreds of long-tail ideas).
  const cleanedSeeds = Array.from(
    new Set(
      (seeds ?? [])
        .map((s) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
        .filter(
          (s) => s.length >= 2 && s.length <= 80 && s.split(/\s+/).length <= 4,
        ),
    ),
  ).slice(0, 20);
  if (cleanedSeeds.length === 0) {
    return {
      ok: false,
      error:
        "No seed keywords. Run Refetch to auto-generate broad head terms (e.g. 'web security'), or paste them into the Seed keywords field.",
    };
  }

  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    return {
      ok: false,
      error: "DataForSEO credentials not set (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).",
    };
  }

  const { DataForSeoClient, filterOutliers } = await import(
    "@/lib/lx/dataforseo"
  );
  const dfs = new DataForSeoClient(login, password);

  // Fan out one Labs call per seed instead of bundling all seeds into a
  // single request. Bundled calls dilute relevance: a generic high-volume
  // match on one seed token (e.g. "security" → "ADT security") drowns out
  // long-tail rows in the niche. Per-seed calls give each seed its own
  // top-N slice; we then aggregate + dedupe + relevance-filter.
  function seedTokens(seed: string): string[] {
    return seed
      .toLowerCase()
      .split(/[\s-]+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length >= 4 && !SEED_TOKEN_STOPLIST.has(t));
  }

  // Map of keyword → best row + which seed(s) it matched (for relevance score).
  const aggregated = new Map<
    string,
    { row: DfsKeywordRow; matchedSeeds: Set<string> }
  >();
  let totalCost = 0;
  const seedErrors: string[] = [];

  for (const seed of cleanedSeeds) {
    try {
      const res = await dfs.keywordIdeas([seed], {
        limit: PER_SEED_LIMIT,
        minVolume: MIN_VOLUME,
        minWords: MIN_WORDS,
        closelyVariants: false,
      });
      totalCost += res.cost;

      // Relevance gate: the returned keyword must contain at least one
      // substantive token from the seed it was generated from. Stops
      // off-niche junk like "michigan sex offenders list" from sneaking
      // in on a "security" seed.
      const tokens = seedTokens(seed);
      const relevant = tokens.length === 0
        ? res.rows
        : res.rows.filter((r) => {
            const kw = r.keyword.toLowerCase();
            return tokens.some((t) => kw.includes(t));
          });

      for (const r of relevant) {
        const key = r.keyword.toLowerCase();
        const existing = aggregated.get(key);
        if (existing) {
          existing.matchedSeeds.add(seed);
          // Keep the higher-volume row in case the same keyword surfaced
          // with different metrics in different per-seed responses.
          if ((r.search_volume ?? 0) > (existing.row.search_volume ?? 0)) {
            existing.row = r;
          }
        } else {
          aggregated.set(key, { row: r, matchedSeeds: new Set([seed]) });
        }
      }
    } catch (err) {
      seedErrors.push(
        `"${seed}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (aggregated.size === 0) {
    return {
      ok: false,
      error:
        seedErrors.length > 0
          ? `No keywords found. Errors: ${seedErrors.join("; ")}`
          : "No keywords found above the volume threshold.",
    };
  }

  // Filter outliers across the aggregated pool (preserves variance-based
  // junk detection that filterOutliers does within a single response).
  const rowsOnly = Array.from(aggregated.values()).map((v) => v.row);
  const filtered = filterOutliers(rowsOnly);

  // Re-attach the matchedSeeds count after outlier filtering so the
  // ranker can prefer keywords that match multiple seeds.
  type Ranked = { row: DfsKeywordRow; matches: number };
  const ranked: Ranked[] = filtered
    .map((r) => ({
      row: r,
      matches: aggregated.get(r.keyword.toLowerCase())?.matchedSeeds.size ?? 1,
    }))
    .sort((a, b) => {
      // Keywords matching multiple seeds first, then by volume.
      if (b.matches !== a.matches) return b.matches - a.matches;
      return (b.row.search_volume ?? 0) - (a.row.search_volume ?? 0);
    })
    .slice(0, TOTAL_RESULT_CAP);

  const suggestions: KeywordSuggestion[] = ranked.map(({ row }) => ({
    keyword: row.keyword,
    searchVolume: row.search_volume ?? 0,
    cpcUsd: row.cpc ?? null,
    competition: row.competition,
  }));
  const tier = `${suggestions.length} long-tail keyword(s) from ${cleanedSeeds.length} seed(s) · ${totalCost > 0 ? `$${totalCost.toFixed(3)}` : "free (cached)"}${seedErrors.length > 0 ? ` · ${seedErrors.length} seed error(s)` : ""}`;
  return { ok: true, suggestions, tier };
}

// ------------------------------------------------------------
// deleteAutoblog — remove just the autoblog config (lx_site row) for
// a project, leaving the project (and any audits, social config, etc.)
// intact. The cascade on lx_site_pkey kills downstream rows
// (lx_keyword, lx_article, lx_site_page, sp_site_account).
// ------------------------------------------------------------
export async function deleteAutoblog(input: {
  projectId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", input.projectId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  // Service role — lx_site delete cascades into child tables that
  // user-scoped RLS can't traverse cleanly.
  const svc = serviceClient();
  const { error } = await svc
    .from("lx_site")
    .delete()
    .eq("project_id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/projects", "layout");
  return { ok: true };
}

// ------------------------------------------------------------
// deleteProject — remove the project row; ON DELETE CASCADE wipes
// lx_site (and its children), audits, sp_site_account, etc.
// ------------------------------------------------------------
export async function deleteProject(input: {
  projectId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  // Confirm ownership on the user client first; service-role does
  // the actual delete (cascade is wide).
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", input.projectId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const { error } = await svc
    .from("projects")
    .delete()
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  revalidatePath("/projects", "layout");
  return { ok: true };
}

// ------------------------------------------------------------
// pause / resume
// ------------------------------------------------------------
export async function setSitePaused(
  paused: boolean,
  projectId?: string,
): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  let lxSiteId: string | null = null;
  if (projectId) {
    const site = await lookupSiteForProject(supabase, user.id, projectId);
    if ("error" in site) return { ok: false, error: site.error };
    lxSiteId = site.id;
  } else {
    const site = (await getCurrentSite("id")) as
      | { lx_site_id: string | null }
      | null;
    lxSiteId = site?.lx_site_id ?? null;
  }
  if (!lxSiteId) return { ok: false, error: "No site selected." };

  const { error } = await supabase
    .from("lx_site")
    .update({ status: paused ? "paused" : "active" })
    .eq("id", lxSiteId)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/autoblog");
  if (projectId) revalidatePath(`/projects/${projectId}/autoblog`);
  return { ok: true };
}

// ------------------------------------------------------------
// generateSchedule — turn the keywords textarea into lx_keyword rows
// queued across the next N days (default 30), honoring publish_days
// + publish_hour. One keyword per publish slot.
//
// Re-running clears any previously-queued rows for this site so we
// don't pile up duplicates after the user edits + regenerates.
// ------------------------------------------------------------
async function lookupSiteForProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  _userId: string,
  projectId: string,
): Promise<
  | { id: string; publish_days: number[]; publish_hour: number; daily_article_count: number }
  | { error: string }
> {
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { error: "Project not found." };
  const { data: site } = await supabase
    .from("lx_site")
    .select("id, publish_days, publish_hour, daily_article_count")
    .eq("project_id", projectId)
    .maybeSingle();
  if (!site) return { error: "No autoblog config — save the form first." };
  return site as {
    id: string;
    publish_days: number[];
    publish_hour: number;
    daily_article_count: number;
  };
}

function computeScheduleSlots(
  publishDays: number[],
  publishHour: number,
  perDay: number,
  count: number,
): Date[] {
  const dates: Date[] = [];
  let cursor = new Date();
  while (dates.length < count) {
    const next = nextPublishAt(publishDays, publishHour, cursor);
    if (!next) break;
    for (let i = 0; i < Math.max(1, perDay) && dates.length < count; i++) {
      dates.push(new Date(next));
    }
    cursor = new Date(next.getTime() + 60_000);
  }
  return dates;
}

export async function generateSchedule(input: {
  projectId: string;
  keywords: string;
  days?: number;
}): Promise<Ok<{ scheduled: number }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const site = await lookupSiteForProject(supabase, user.id, input.projectId);
  if ("error" in site) return { ok: false, error: site.error };

  const rows = parseKeywordRows(input.keywords, 500, MAX.keyword + 20);
  if (rows.length === 0) {
    return { ok: false, error: "No keywords to schedule." };
  }

  // Each row is "<keyword>,<volume>" — split out both halves so the
  // lx_keyword.search_volume column stays populated for downstream
  // ranking.
  const parsed = rows.map((row) => {
    const idx = row.indexOf(",");
    if (idx === -1) return { keyword: row.trim(), volume: null as number | null };
    const k = row.slice(0, idx).trim();
    const vRaw = row.slice(idx + 1).trim();
    const v = /^\d+$/.test(vRaw) ? parseInt(vRaw, 10) : null;
    return { keyword: k, volume: v };
  }).filter((p) => p.keyword.length >= 2);

  const days = Math.max(1, Math.min(90, input.days ?? 30));
  // One slot per day per perDay-count over `days` days. Cap at the
  // number of keywords we actually have.
  const targetCount = Math.min(parsed.length, days * Math.max(1, site.daily_article_count));
  const slots = computeScheduleSlots(
    site.publish_days,
    site.publish_hour,
    site.daily_article_count,
    targetCount,
  );

  // lx_keyword RLS is select-only, so user-scoped writes get rejected.
  // We've already validated project ownership above via the user
  // client; the writes go through the service-role client.
  const svc = serviceClient();

  // Clear previously-queued rows so re-running this doesn't pile up
  // duplicates. Status='published' / 'failed' stay so history is
  // preserved.
  const { error: delErr } = await svc
    .from("lx_keyword")
    .delete()
    .eq("site_id", site.id)
    .eq("status", "queued");
  if (delErr) return { ok: false, error: delErr.message };

  const insertRows = parsed.slice(0, slots.length).map((p, i) => ({
    site_id: site.id,
    keyword: p.keyword,
    scheduled_for: slots[i]?.toISOString().slice(0, 10) ?? null,
    status: "queued",
    source: "manual",
    search_volume: p.volume,
  }));

  if (insertRows.length === 0) {
    return { ok: false, error: "No publish slots available — check publish days." };
  }

  const { error: insErr } = await svc.from("lx_keyword").insert(insertRows);
  if (insErr) return { ok: false, error: insErr.message };

  // Move the site's next_publish_at to the first scheduled slot so the
  // cron picks this up on its next sweep.
  await svc
    .from("lx_site")
    .update({
      next_publish_at: slots[0]?.toISOString() ?? null,
      status: "active",
    })
    .eq("id", site.id);

  revalidatePath("/projects", "layout");
  return { ok: true, scheduled: insertRows.length };
}

// ------------------------------------------------------------
// previewNow — enqueue an immediate article generation that STOPS at
// status='ready' (no webhook deliver). Used as the "preview the next
// post before publishing" button on the setup page. The user can
// review on /autoblog/articles/<id> and explicitly click Publish to
// deliver via webhook.
// ------------------------------------------------------------
export async function previewNow(input: {
  projectId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const site = await lookupSiteForProject(supabase, user.id, input.projectId);
  if ("error" in site) return { ok: false, error: site.error };

  // Verify at least one queued keyword exists; the worker silently
  // skips when the queue is empty, which would otherwise look like
  // success but produce nothing.
  const { count } = await supabase
    .from("lx_keyword")
    .select("id", { count: "exact", head: true })
    .eq("site_id", site.id)
    .eq("status", "queued");
  if (!count || count === 0) {
    return {
      ok: false,
      error: "No queued keywords. Click Generate 30-day schedule first.",
    };
  }

  const queued = await enqueueArticleGenerate(site.id, {
    preview: true,
    manual: true,
  });
  if (!queued.ok) return { ok: false, error: queued.error };
  revalidatePath("/projects", "layout");
  return { ok: true };
}

// ------------------------------------------------------------
// publishArticle — fire the webhook delivery for an already-generated
// (status='ready') article. Used by the Publish button on the
// /autoblog/articles/<id> preview page after the user has reviewed.
// ------------------------------------------------------------
export async function publishArticle(input: {
  articleId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Confirm ownership via the lx_article → lx_site → user_id chain
  // before letting the user trigger a deliver.
  const { data: article } = await supabase
    .from("lx_article")
    .select("id, status, lx_site!lx_article_site_id_fkey!inner(user_id)")
    .eq("id", input.articleId)
    .maybeSingle();
  if (!article || (article as any).lx_site?.user_id !== user.id) {
    return { ok: false, error: "Article not found." };
  }
  if (article.status !== "ready") {
    return {
      ok: false,
      error: `Article is in '${article.status}' state — only 'ready' articles can be published.`,
    };
  }

  const queued = await enqueueArticleDeliver(input.articleId);
  if (!queued.ok) return { ok: false, error: queued.error };
  revalidatePath("/projects", "layout");
  return { ok: true };
}
