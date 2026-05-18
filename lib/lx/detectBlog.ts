// Two-phase blog profile detection.
//
// PHASE 1 — discoverBlogUrls(homepageUrl):
//   Fetch the homepage HTML and extract:
//     • blogUrl    — link to the actual blog index (nav text "blog" /
//                    href contains /blog, plus a /blog fallback probe).
//                    If the input URL already looks bloggy, returned as-is.
//     • feedUrl    — <link rel="alternate" type="application/rss+xml"|
//                    "application/atom+xml" href="…">. Also probes
//                    /feed, /rss.xml, /atom.xml if no <link> declared.
//     • sitemapUrl — robots.txt Sitemap: directive, then /sitemap.xml,
//                    then /sitemap_index.xml.
//   No LLM call. Fast (<3s typical). The form uses this to decide which
//   fields to ask the user to fill in manually.
//
// PHASE 2 — enrichBlogProfile({ blogUrl, feedUrl, sitemapUrl }):
//   Now that we have the real URLs (either auto-found or user-supplied),
//   fetch:
//     • the feed (gives the cleanest sample of THE BLOG's recent
//       output — title, description, ~10 post titles)
//     • the blog page HTML as a fallback / supplement
//   Pass everything to Claude Haiku 4.5 and ask for { niche,
//   target_audiences, description }. Haiku is cheap (<$0.005/call here)
//   and fast (<3s typical). If the LLM call fails, we return empty
//   strings for those fields and let the user type them.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zod helper imports from "zod/v4" internally and calls
// z.toJSONSchema() — a v4-only API. Importing plain "zod" gives v3
// schemas whose `_def` shape v4 can't read, producing the
// "Cannot read properties of undefined (reading 'def')" crash.
import { z } from "zod/v4";
import { detectSitemapUrl } from "./sitemap";

const FETCH_TIMEOUT_MS = 8000;
const UA = "Crawlproof-LinkExchange/1.0 (+https://crawlproof.com)";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_EXCERPT_CHARS = 8000;
const FEED_ITEM_CAP = 10;

// ============================================================
// Shared HTTP helpers
// ============================================================

async function fetchText(
  url: string,
  accept: string = "text/html,*/*;q=0.5",
): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, accept },
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOk(url: string): Promise<boolean> {
  const r = await fetchText(url);
  return !!r && r.status === 200;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// URL normalization
// ============================================================

export function normalizeInputUrl(
  raw: string,
): { ok: true; url: string; origin: string; domain: string } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "empty url" };
  const trimmed = raw.trim();
  // Reject non-http(s) up front so the auto-prefix branch below doesn't
  // smuggle "ftp://x" into a URL("https://ftp://x") parse that succeeds.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { ok: false, reason: "non-http(s) URL" };
  }
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "non-http(s) URL" };
    }
    u.hash = "";
    return {
      ok: true,
      url: u.toString(),
      origin: `${u.protocol}//${u.host}`,
      domain: u.hostname.toLowerCase().replace(/^www\./, ""),
    };
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
}

function absolutize(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// ============================================================
// Phase-1 deterministic extractors (pure, easy to unit-test)
// ============================================================

// Look for a feed declared in <head>: <link rel="alternate"
// type="application/rss+xml" href="…"> or atom+xml. Returns the
// absolute URL or null.
export function extractFeedLinkFromHtml(html: string, baseUrl: string): string | null {
  const head = html.slice(0, 50000);
  const re =
    /<link[^>]+rel=["']?alternate["']?[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) {
    const tag = m[0];
    if (!/type=["'](application\/(?:rss|atom)\+xml)["']/i.test(tag)) continue;
    const hrefM = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefM) continue;
    const abs = absolutize(baseUrl, hrefM[1]);
    if (abs) return abs;
  }
  return null;
}

// Look at the homepage's anchor tags for one pointing at the blog.
// Heuristic: anchor text or href contains "blog" (case-insensitive)
// AND the resolved href stays on the same origin. Returns the first
// match — usually the nav link.
export function extractBlogLinkFromHtml(
  html: string,
  baseUrl: string,
): string | null {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return null;
    }
  })();
  if (!origin) return null;
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = stripTags(m[2]).toLowerCase();
    const looksBlog = /\bblog\b/.test(text) || /\/blog(\/|$|\?)/i.test(href);
    if (!looksBlog) continue;
    const abs = absolutize(baseUrl, href);
    if (!abs) continue;
    try {
      const u = new URL(abs);
      if (u.origin !== origin) continue;
      // Reject mailto / fragment-only and obvious noise.
      if (u.pathname === "" || u.pathname === "/") continue;
      return abs;
    } catch {
      continue;
    }
  }
  return null;
}

// Decide whether the user gave us the blog URL directly. If the input
// path or page title screams "blog", treat the input as the blog URL.
export function looksLikeBlogUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\/blog(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

// ============================================================
// Phase 1 — discoverBlogUrls
// ============================================================

export type DiscoveredUrls = {
  homepageUrl: string;
  domain: string;
  blogUrl: string | null;
  feedUrl: string | null;
  sitemapUrl: string | null;
};

export async function discoverBlogUrls(
  rawUrl: string,
): Promise<{ ok: true; urls: DiscoveredUrls } | { ok: false; error: string }> {
  const normalized = normalizeInputUrl(rawUrl);
  if (!normalized.ok) return { ok: false, error: normalized.reason };

  const fetched = await fetchText(normalized.url);
  if (!fetched || fetched.status >= 400) {
    return { ok: false, error: "couldn't fetch that URL" };
  }

  // Probe sitemap + feed in parallel with whatever HTML scraping we do.
  const sitemapPromise = detectSitemapUrl(normalized.domain);

  let feedUrl = extractFeedLinkFromHtml(fetched.body, normalized.url);
  if (!feedUrl) {
    for (const candidate of ["/feed", "/feed.xml", "/rss.xml", "/atom.xml"]) {
      if (await probeOk(normalized.origin + candidate)) {
        feedUrl = normalized.origin + candidate;
        break;
      }
    }
  }

  let blogUrl: string | null = null;
  if (looksLikeBlogUrl(normalized.url)) {
    blogUrl = normalized.url;
  } else {
    blogUrl = extractBlogLinkFromHtml(fetched.body, normalized.url);
    if (!blogUrl && (await probeOk(normalized.origin + "/blog"))) {
      blogUrl = normalized.origin + "/blog";
    }
  }

  const sitemapUrl = await sitemapPromise;

  return {
    ok: true,
    urls: {
      homepageUrl: normalized.url,
      domain: normalized.domain,
      blogUrl,
      feedUrl,
      sitemapUrl,
    },
  };
}

// ============================================================
// Phase 2 — feed + page parsing and LLM enrichment
// ============================================================

export type FeedSummary = {
  title: string | null;
  description: string | null;
  items: Array<{ title: string; description: string | null; categories: string[] }>;
};

// Minimal RSS/Atom parser. Pulls channel/title + description, item
// title + description (or summary), and categories. We avoid a heavy
// XML dep; the shape is regular enough that targeted regex is fine
// for the small slice we need.
export function parseFeed(xml: string): FeedSummary {
  const out: FeedSummary = { title: null, description: null, items: [] };
  if (!xml) return out;

  const isAtom = /<feed[\s>]/i.test(xml) && /xmlns=["']https?:\/\/www\.w3\.org\/2005\/Atom/i.test(xml);

  if (isAtom) {
    const titleM = xml.match(/<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    const subM = xml.match(/<feed[\s\S]*?<subtitle[^>]*>([\s\S]*?)<\/subtitle>/i);
    out.title = titleM ? decodeEntities(stripTags(titleM[1])) : null;
    out.description = subM ? decodeEntities(stripTags(subM[1])) : null;
    const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml)) !== null && out.items.length < FEED_ITEM_CAP) {
      const entry = m[0];
      const t = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const s =
        entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) ||
        entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
      const cats = Array.from(entry.matchAll(/<category[^>]+term=["']([^"']+)["']/gi)).map(
        (c) => c[1],
      );
      if (t) {
        out.items.push({
          title: decodeEntities(stripTags(t[1])),
          description: s ? decodeEntities(stripTags(s[1])).slice(0, 400) : null,
          categories: cats,
        });
      }
    }
    return out;
  }

  // RSS 2.0
  const chanTitleM = xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  const chanDescM = xml.match(/<channel[\s\S]*?<description[^>]*>([\s\S]*?)<\/description>/i);
  out.title = chanTitleM ? decodeEntities(stripTags(chanTitleM[1])) : null;
  out.description = chanDescM ? decodeEntities(stripTags(chanDescM[1])) : null;
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.items.length < FEED_ITEM_CAP) {
    const item = m[0];
    const t = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const d = item.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const cats = Array.from(item.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)).map((c) =>
      stripTags(c[1]),
    );
    if (t) {
      out.items.push({
        title: decodeEntities(stripTags(t[1])),
        description: d ? decodeEntities(stripTags(d[1])).slice(0, 400) : null,
        categories: cats,
      });
    }
  }
  return out;
}

// Lightweight page summary (used as supplement to the feed, or alone
// when there's no feed).
export function extractPageExcerpt(html: string): {
  title: string | null;
  description: string | null;
  siteName: string | null;
  h1: string | null;
  body: string;
} {
  const head = html.slice(0, 50000);
  const titleM =
    head.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descM =
    head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    head.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const siteNameM = head.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
  );
  const h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  body = stripTags(body).slice(0, 2000);
  return {
    title: titleM ? decodeEntities(stripTags(titleM[1])).slice(0, 200) : null,
    description: descM ? decodeEntities(descM[1].trim()).slice(0, 500) : null,
    siteName: siteNameM ? decodeEntities(siteNameM[1].trim()).slice(0, 100) : null,
    h1: h1M ? decodeEntities(stripTags(h1M[1])).slice(0, 200) : null,
    body,
  };
}

// ============================================================
// LLM enrichment
// ============================================================

const ProfileLLMOutput = z.object({
  niche: z.string().min(2).max(120),
  target_audiences: z.array(z.string().min(2).max(80)).min(1).max(6),
  description: z.string().min(40).max(800),
  seed_keywords: z.array(z.string().min(2).max(40)).min(3).max(6),
  keywords: z.array(z.string().min(2).max(60)).min(5).max(15),
  seo_title: z.string().min(10).max(70),
  seo_description: z.string().min(50).max(160),
  tone: z.string().min(3).max(120),
  competitors: z.array(z.string().min(3).max(120)).min(0).max(5),
});

const SYSTEM_PROMPT = [
  "You are profiling a website to seed a SEO autoblogging tool.",
  "Given the page content (and optionally a recent-posts feed), output a JSON object with these fields:",
  "  niche — 2-6 word phrase describing the topical area (e.g. 'cybersecurity for SaaS', 'home-coffee gear reviews').",
  "  target_audiences — 2-4 short audience labels (e.g. 'security engineers', 'CTOs', 'home barista hobbyists').",
  "  description — 2-3 sentences describing what the site does and the tone to write in. Address the AI writer in second person ('You are writing for…').",
  "  seed_keywords — 3-6 BROAD 1-3 word head terms that a keyword research tool can expand. These feed DataForSEO's keyword-ideas API, so they must be common search terms with real volume (e.g. 'web security', 'cyber security', 'penetration testing'), NOT long-tail phrases. Lowercase.",
  "  keywords — 5-15 SEO keyword phrases. Strongly prefer 3-5 word long-tail phrases (e.g. 'soc2 compliance for startups' over 'soc2'); long-tail converts and ranks faster. Lowercase, no quotes.",
  "  seo_title — a 50-60 character page <title> for the blog homepage. Brand-included, keyword-rich, human-readable.",
  "  seo_description — a 140-160 character meta description for the blog homepage. Active voice, ends with a soft CTA.",
  "  tone — 3-6 short tone descriptors comma-separated (e.g. 'technical, irreverent, no-fluff' or 'warm, practical, beginner-friendly').",
  "  competitors — 0-5 well-known sites in the same niche (domain or brand name, e.g. 'stripe.com', 'Indie Hackers'). Empty array if uncertain.",
  "Be specific. Do not write marketing fluff. If you cannot tell, say so honestly in the description.",
].join("\n");

function buildEnrichmentPrompt(input: {
  blogUrl: string;
  feed: FeedSummary | null;
  excerpt: ReturnType<typeof extractPageExcerpt> | null;
}): string {
  const lines: string[] = [];
  lines.push(`Blog URL: ${input.blogUrl}`);

  if (input.feed) {
    lines.push("\n=== RSS/Atom feed ===");
    if (input.feed.title) lines.push(`Feed title: ${input.feed.title}`);
    if (input.feed.description) lines.push(`Feed description: ${input.feed.description}`);
    if (input.feed.items.length > 0) {
      lines.push("\nRecent posts:");
      for (const item of input.feed.items) {
        lines.push(`- ${item.title}`);
        if (item.description) lines.push(`    ${item.description.slice(0, 200)}`);
        if (item.categories.length > 0) {
          lines.push(`    categories: ${item.categories.join(", ")}`);
        }
      }
    }
  }

  if (input.excerpt) {
    lines.push("\n=== Blog page excerpt ===");
    if (input.excerpt.siteName) lines.push(`Site name: ${input.excerpt.siteName}`);
    if (input.excerpt.title) lines.push(`Title: ${input.excerpt.title}`);
    if (input.excerpt.h1) lines.push(`H1: ${input.excerpt.h1}`);
    if (input.excerpt.description) lines.push(`Meta description: ${input.excerpt.description}`);
    if (input.excerpt.body) lines.push(`\nBody:\n${input.excerpt.body}`);
  }

  const full = lines.join("\n");
  return full.length > MAX_EXCERPT_CHARS ? full.slice(0, MAX_EXCERPT_CHARS) + "…" : full;
}

export type EnrichmentInput = {
  blogUrl: string;
  feedUrl: string | null;
  sitemapUrl: string | null;
};

export type EnrichmentResult = {
  niche: string;
  targetAudiences: string[];
  description: string;
  seedKeywords: string[];
  keywords: string[];
  seoTitle: string;
  seoDescription: string;
  tone: string;
  competitors: string[];
};

export async function enrichBlogProfile(
  input: EnrichmentInput,
  deps?: { anthropicApiKey?: string },
): Promise<{ ok: true; profile: EnrichmentResult } | { ok: false; error: string }> {
  // Pull the feed and the blog page in parallel.
  const [feedRes, blogRes] = await Promise.all([
    input.feedUrl ? fetchText(input.feedUrl, "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5") : Promise.resolve(null),
    fetchText(input.blogUrl),
  ]);

  const feed = feedRes && feedRes.status < 400 ? parseFeed(feedRes.body) : null;
  const excerpt = blogRes && blogRes.status < 400 ? extractPageExcerpt(blogRes.body) : null;

  if (!feed && !excerpt) {
    return { ok: false, error: "couldn't fetch the blog URL or feed" };
  }

  const apiKey = deps?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  }

  const prompt = buildEnrichmentPrompt({ blogUrl: input.blogUrl, feed, excerpt });

  try {
    const anthropic = new Anthropic({ apiKey });
    const stream = anthropic.messages.stream({
      model: HAIKU_MODEL,
      max_tokens: 700,
      // Haiku 4.5 has no adaptive thinking and rejects the `effort`
      // parameter — only Sonnet/Opus accept it. Pass `format` alone.
      output_config: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        format: zodOutputFormat(ProfileLLMOutput as any),
      },
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: prompt }],
    });
    const response = await stream.finalMessage();
    const parsed = response.parsed_output as z.infer<typeof ProfileLLMOutput> | null;
    if (!parsed) {
      return { ok: false, error: "model returned no parsed output" };
    }
    return {
      ok: true,
      profile: {
        niche: parsed.niche,
        targetAudiences: parsed.target_audiences,
        description: parsed.description,
        seedKeywords: parsed.seed_keywords,
        keywords: parsed.keywords,
        seoTitle: parsed.seo_title,
        seoDescription: parsed.seo_description,
        tone: parsed.tone,
        competitors: parsed.competitors,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
