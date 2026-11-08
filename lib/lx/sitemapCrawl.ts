// Sitemap crawl + page-metadata + embeddings pipeline.
//
// Inputs: a site_id whose lx_site row has sitemap_url + blog_root_url set.
// Outputs: lx_site_page rows (one per discovered URL) with title, description,
//          is_blog_post flag, and a 1536-dim embedding for internal-link
//          matching.
//
// Behavior:
//  * Handles <urlset>, <sitemapindex>, and nested sitemapindex (up to 3 levels).
//  * Sorts sub-sitemaps most-recent-first (lastmod desc, or reverse document
//    order when lastmod is absent) so the MAX_PAGES cap fills from new content.
//  * Caps at MAX_PAGES per site to bound cost on huge sitemaps.
//  * Fetches page HTML with HTML_CONCURRENCY parallel requests.
//  * Embeds titles+descriptions in batches of EMBED_BATCH.
//  * Idempotent — re-running re-embeds and updates last_seen_at; pages
//    that disappear from the sitemap are NOT deleted in v1 (they just go
//    stale; cleanup is a future job).

import type { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { CRAWL_FETCH_TIMEOUT_MS, CrawlHttpError, crawlRecheckAt } from "@/lib/crawl/policy";

const FETCH_TIMEOUT_MS = CRAWL_FETCH_TIMEOUT_MS;
const UA = "Crawlproof-LinkExchange/1.0 (+https://crawlproof.com)";
const MAX_PAGES = 200;
const HTML_CONCURRENCY = 5;
const EMBED_BATCH = 100;
const EMBED_MODEL = "text-embedding-3-small"; // 1536 dims, matches schema
const MAX_NESTED_SITEMAPS = 20;

type SiteRow = {
  id: string;
  sitemap_url: string;
  blog_root_url: string;
};

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The root sitemap, or a thrown error saying why not. Unlike fetchText this
// does not swallow the failure: a sitemap that times out or 5xxs used to be
// recorded as "empty", which reads as "this site has no pages" and is never
// retried.
async function fetchRoot(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA },
    });
    if (!res.ok) throw new CrawlHttpError(res.status, res.headers.get("retry-after"));
    return await res.text();
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Columns for a failed crawl: flag it and schedule the one recheck 30 days out
 * (fleet crawler policy, lib/crawl/policy.ts). Covers our own failures
 * (embedding quota, DB) too: before this an errored sitemap was never crawled
 * again unless somebody pressed refresh.
 */
export function sitemapFailureFields(status: string, now: Date) {
  return {
    sitemap_status: status,
    last_sitemap_fetch_at: now.toISOString(),
    sitemap_failed_at: now.toISOString(),
    sitemap_next_check_at: crawlRecheckAt(now).toISOString(),
  };
}

/** Columns for a crawl that finished: clears any flag. */
export function sitemapSuccessFields(status: string, now: Date) {
  return {
    sitemap_status: status,
    last_sitemap_fetch_at: now.toISOString(),
    sitemap_failed_at: null,
    sitemap_next_check_at: null,
  };
}

/** A recheck claim holds the row this long, so a crash mid-crawl is retried rather than lost. */
const RECHECK_CLAIM_MS = 24 * 60 * 60 * 1000;

/**
 * Sites whose failed sitemap is owed its 30-day recheck, claimed (next check
 * pushed a day out) so an overlapping sweep cannot crawl them twice. The crawl
 * itself then writes the real outcome.
 */
export async function claimDueSitemapRechecks(
  supabase: SupabaseClient<any>,
  now: Date = new Date(),
  limit = 5,
): Promise<string[]> {
  const { data } = await supabase
    .from("lx_site")
    .select("id")
    .lte("sitemap_next_check_at", now.toISOString())
    .order("sitemap_next_check_at", { ascending: true })
    .limit(limit);
  const ids: string[] = [];
  for (const row of (data ?? []) as Array<{ id: string }>) {
    const { data: claimed } = await supabase
      .from("lx_site")
      .update({ sitemap_next_check_at: new Date(now.getTime() + RECHECK_CLAIM_MS).toISOString() })
      .eq("id", row.id)
      .lte("sitemap_next_check_at", now.toISOString())
      .select("id")
      .maybeSingle();
    if (claimed) ids.push(row.id);
  }
  return ids;
}

// Extract <loc>...</loc> values. Works for both urlset and sitemapindex.
export function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

export type SitemapEntry = { loc: string; lastmod: string | null };

// Extract <sitemap> index entries with optional lastmod.
export function extractSitemapEntries(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const re = /<sitemap(?:\s[^>]*)?>[\s\S]*?<\/sitemap>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = m[0].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
    if (!loc) continue;
    const lm = m[0].match(/<lastmod>\s*(\S+)\s*<\/lastmod>/i);
    out.push({ loc: loc[1], lastmod: lm ? lm[1] : null });
  }
  return out;
}

// Extract <url> leaf entries with optional lastmod.
export function extractUrlEntries(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const re = /<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const loc = m[0].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i);
    if (!loc) continue;
    const lm = m[0].match(/<lastmod>\s*(\S+)\s*<\/lastmod>/i);
    out.push({ loc: loc[1], lastmod: lm ? lm[1] : null });
  }
  return out;
}

// Sort most-recent-first: by lastmod desc when available, else reverse
// document order (CMSes typically append newer entries at the end).
export function sortByRecency(entries: SitemapEntry[]): SitemapEntry[] {
  if (entries.some((e) => e.lastmod !== null)) {
    return [...entries].sort((a, b) => {
      const ta = a.lastmod ? Date.parse(a.lastmod) : 0;
      const tb = b.lastmod ? Date.parse(b.lastmod) : 0;
      return tb - ta;
    });
  }
  return [...entries].reverse();
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

// Recursive URL collector. Handles up to MAX_SITEMAP_DEPTH levels of nesting.
// Fills acc in recency order; stops as soon as acc.length >= MAX_PAGES.
const MAX_SITEMAP_DEPTH = 3;

async function collectUrls(xml: string, depth: number, acc: string[]): Promise<void> {
  if (acc.length >= MAX_PAGES || depth >= MAX_SITEMAP_DEPTH) return;

  if (!isSitemapIndex(xml)) {
    for (const e of sortByRecency(extractUrlEntries(xml))) {
      acc.push(e.loc);
      if (acc.length >= MAX_PAGES) return;
    }
    return;
  }

  const subEntries = sortByRecency(extractSitemapEntries(xml)).slice(0, MAX_NESTED_SITEMAPS);
  for (const sub of subEntries) {
    if (acc.length >= MAX_PAGES) return;
    const body = await fetchText(sub.loc);
    if (!body) continue;
    await collectUrls(body, depth + 1, acc);
  }
}

async function discoverUrls(sitemapUrl: string): Promise<string[]> {
  const root = await fetchRoot(sitemapUrl);
  const acc: string[] = [];
  await collectUrls(root, 0, acc);
  return acc;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

// Lightweight metadata extraction — no DOM parser, just targeted regex
// against the head. We're not asking for perfection; this feeds an
// embedding so "mostly right" is fine.
export function extractMeta(html: string): { title: string | null; description: string | null } {
  const head = html.slice(0, 50000); // cap at 50KB to avoid pathological pages
  const titleMatch =
    head.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    head.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
    head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    head.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);

  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim().slice(0, 300) : null;
  const description = descMatch
    ? decodeEntities(descMatch[1]).replace(/\s+/g, " ").trim().slice(0, 500)
    : null;
  return { title, description };
}

async function fetchPageMeta(url: string): Promise<{
  url: string;
  title: string | null;
  description: string | null;
  ok: boolean;
}> {
  const html = await fetchText(url);
  if (!html) return { url, title: null, description: null, ok: false };
  const meta = extractMeta(html);
  return { url, ...meta, ok: true };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function isBlogPost(url: string, blogRootUrl: string): boolean {
  try {
    const u = new URL(url);
    const root = new URL(blogRootUrl);
    if (u.host !== root.host) return false;
    // Path must live under the blog root *and* have at least one more
    // segment beyond it (e.g. /blog/my-post, not /blog or /blog/).
    const rootPath = root.pathname.replace(/\/$/, "");
    if (!u.pathname.startsWith(rootPath + "/")) return false;
    return u.pathname.slice(rootPath.length).split("/").filter(Boolean).length >= 1;
  } catch {
    return false;
  }
}

async function embedBatch(
  openai: OpenAI,
  inputs: string[],
): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: inputs,
  });
  return res.data.map((d) => d.embedding as number[]);
}

export type CrawlResult = {
  ok: boolean;
  discovered: number;
  fetched: number;
  embedded: number;
  error?: string;
};

export async function crawlSitemap(
  siteId: string,
  deps: { supabase: SupabaseClient<any>; openai: OpenAI },
): Promise<CrawlResult> {
  const { supabase, openai } = deps;
  const { data: site, error: siteErr } = await supabase
    .from("lx_site")
    .select("id, sitemap_url, blog_root_url")
    .eq("id", siteId)
    .maybeSingle<SiteRow>();
  if (siteErr || !site) {
    return { ok: false, discovered: 0, fetched: 0, embedded: 0, error: "site not found" };
  }

  await supabase
    .from("lx_site")
    .update({ sitemap_status: "crawling" })
    .eq("id", site.id);

  let urls: string[] = [];
  try {
    urls = (await discoverUrls(site.sitemap_url))
      .filter((u, i, arr) => arr.indexOf(u) === i)
      .slice(0, MAX_PAGES);
  } catch (err) {
    await supabase
      .from("lx_site")
      .update(
        sitemapFailureFields(`error: ${err instanceof Error ? err.message : "fetch failed"}`, new Date()),
      )
      .eq("id", site.id);
    return {
      ok: false,
      discovered: 0,
      fetched: 0,
      embedded: 0,
      error: "sitemap fetch failed",
    };
  }

  if (urls.length === 0) {
    await supabase
      .from("lx_site")
      .update(sitemapSuccessFields("empty", new Date()))
      .eq("id", site.id);
    return { ok: true, discovered: 0, fetched: 0, embedded: 0 };
  }

  const fetched = await mapWithConcurrency(urls, HTML_CONCURRENCY, fetchPageMeta);
  const okPages = fetched.filter((p) => p.ok && (p.title || p.description));

  // Build embedding inputs only for pages we'll write.
  const embedInputs = okPages.map((p) => {
    const t = p.title ?? "";
    const d = p.description ?? "";
    return [t, d].filter(Boolean).join("\n\n").slice(0, 8000);
  });

  const embeddings: number[][] = [];
  for (let i = 0; i < embedInputs.length; i += EMBED_BATCH) {
    const batch = embedInputs.slice(i, i + EMBED_BATCH);
    if (batch.length === 0) continue;
    try {
      const out = await embedBatch(openai, batch);
      embeddings.push(...out);
    } catch (err) {
      await supabase
        .from("lx_site")
        .update(
          sitemapFailureFields(
            `error: embedding ${err instanceof Error ? err.message : "failed"}`,
            new Date(),
          ),
        )
        .eq("id", site.id);
      return {
        ok: false,
        discovered: urls.length,
        fetched: okPages.length,
        embedded: 0,
        error: "embedding failed",
      };
    }
  }

  // Upsert rows. pgvector expects an array literal "[v1,v2,...]" — supabase-js
  // serializes JS arrays directly when the column type is vector.
  const now = new Date().toISOString();
  const rows = okPages.map((p, i) => ({
    site_id: site.id,
    url: p.url,
    title: p.title,
    description: p.description,
    embedding: embeddings[i] ?? null,
    is_blog_post: isBlogPost(p.url, site.blog_root_url),
    last_seen_at: now,
  }));

  // Batch upsert in chunks of 200 to keep the request payload small.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase
      .from("lx_site_page")
      .upsert(chunk, { onConflict: "site_id,url" });
    if (error) {
      await supabase
        .from("lx_site")
        .update(sitemapFailureFields(`error: ${error.message}`, new Date()))
        .eq("id", site.id);
      return {
        ok: false,
        discovered: urls.length,
        fetched: okPages.length,
        embedded: embeddings.length,
        error: error.message,
      };
    }
  }

  await supabase
    .from("lx_site")
    .update(sitemapSuccessFields(`ok (${rows.length} pages)`, new Date(now)))
    .eq("id", site.id);

  return {
    ok: true,
    discovered: urls.length,
    fetched: okPages.length,
    embedded: embeddings.length,
  };
}
