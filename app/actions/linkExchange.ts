"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { detectSitemapUrl } from "@/lib/lx/sitemap";
import { nextPublishAt } from "@/lib/lx/schedule";
import { enqueueSitemapCrawl } from "@/lib/lx/workerClient";
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
  return clean(input, maxItems * (itemMax + 2))
    .split(",")
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

  // Reject duplicates per-user — same domain already added.
  const { data: existing } = await supabase
    .from("lx_site")
    .select("id")
    .eq("user_id", user.id)
    .eq("domain", domain)
    .maybeSingle();
  if (existing) {
    await setCurrentSite(existing.id as string);
    revalidatePath("/dashboard");
    return { ok: true, siteId: existing.id as string };
  }

  const { data: inserted, error } = await supabase
    .from("lx_site")
    .insert({
      user_id: user.id,
      domain,
      url: `https://${domain}`,
      // name lives in lx_site if the column exists; harmless coalesce
      // because supabase ignores unknown columns when not strict-mode.
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

  await setCurrentSite(inserted.id as string);
  revalidatePath("/dashboard");
  return { ok: true, siteId: inserted.id as string };
}

// ------------------------------------------------------------
// enrichFromUrls — phase 2 of the new wizard. With confirmed URLs
// (auto-found or user-supplied), scrape the blog + feed and ask
// Claude Haiku to extract niche / audiences / description.
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
  domain: string;
  blogRootUrl: string;
  sitemapUrl: string;
  niche: string;
  targetAudiences: string;
  description: string;
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
  const keywords = parseList(input.keywords, MAX.keywords, MAX.keyword);
  const seoTitle = clean(input.seoTitle, MAX.seoTitle) || null;
  const seoDescription = clean(input.seoDescription, MAX.seoDescription) || null;
  const tone = clean(input.tone, MAX.tone) || null;
  const competitors = parseList(input.competitors, MAX.competitors, MAX.competitor);

  const dailyArticleCount = Math.max(1, Math.min(5, Math.floor(input.dailyArticleCount || 1)));
  const publishHour = Math.max(0, Math.min(23, Math.floor(input.publishHour ?? 9)));
  const internalLinks = Math.max(0, Math.min(8, Math.floor(input.internalLinksPerArticle ?? 3)));
  const backlinksEnabled = !!input.backlinksEnabled;
  const externalLinks = Math.max(0, Math.min(5, Math.floor(input.externalLinksPerArticle ?? 3)));
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

  // Multi-site: if siteId is provided, edit that one; verify
  // ownership. Otherwise, this is a create.
  let existing: { id: string } | null = null;
  if (input.siteId) {
    const { data } = await supabase
      .from("lx_site")
      .select("id")
      .eq("id", input.siteId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) return { ok: false, error: "Site not found." };
    existing = data as { id: string };
  }

  const nextAt = nextPublishAt(publishDays, publishHour);

  if (existing) {
    const { data: prev } = await supabase
      .from("lx_site")
      .select("sitemap_url")
      .eq("id", existing.id)
      .maybeSingle();
    const updatePayload: Record<string, unknown> = {
      domain,
      url: `https://${domain}`,
      blog_root_url: blogRootUrl,
      sitemap_url: sitemapUrl,
      niche,
      target_audiences: audiences,
      description,
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
      next_publish_at: nextAt?.toISOString() ?? null,
    };
    const { error } = await supabase
      .from("lx_site")
      .update(updatePayload)
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    if (prev?.sitemap_url !== sitemapUrl) {
      await enqueueSitemapCrawl(existing.id);
    }
    revalidatePath("/autoblog");
    return { ok: true, siteId: existing.id };
  }

  const { data: inserted, error } = await supabase
    .from("lx_site")
    .insert({
      user_id: user.id,
      domain,
      url: `https://${domain}`,
      blog_root_url: blogRootUrl,
      sitemap_url: sitemapUrl,
      niche,
      target_audiences: audiences,
      description,
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
      next_publish_at: nextAt?.toISOString() ?? null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    return { ok: false, error: error?.message ?? "Could not save site." };
  }

  await enqueueSitemapCrawl(inserted.id);
  // Multi-site: a fresh create becomes the active site so the user
  // doesn't have to manually pick it from the picker after onboarding.
  await setCurrentSite(inserted.id);
  revalidatePath("/autoblog");
  return { ok: true, siteId: inserted.id };
}

// ------------------------------------------------------------
// pause / resume
// ------------------------------------------------------------
export async function setSitePaused(paused: boolean): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const site = (await getCurrentSite("id")) as { id: string } | null;
  if (!site) return { ok: false, error: "No site selected." };

  const { error } = await supabase
    .from("lx_site")
    .update({ status: paused ? "paused" : "active" })
    .eq("id", site.id)
    .eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/autoblog");
  return { ok: true };
}
