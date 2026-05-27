import * as cheerio from "cheerio";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectSitemapUrl } from "@/lib/lx/sitemap";
import { postViaAccount, type PostSource } from "@/lib/sp/post";

const USER_AGENT = "CrawlProofSocialFeed/1.0";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_RSS_ITEMS = 50;
const MAX_SITEMAP_URLS = 500;
const FEED_POLL_EVERY_MS = 15 * 60 * 1000;

export type FeedType = "sitemap" | "rss";

type FeedConfig = {
  id: string;
  user_id: string;
  project_id: string;
  feed_type: FeedType;
  feed_url: string | null;
  ignore_paths: string[] | null;
  last_checked_at: string | null;
};

type ProjectRow = {
  id: string;
  url: string;
};

type FeedItem = {
  url: string;
  title: string | null;
  publishedAt: string | null;
};

export type FeedProcessResult = {
  ok: boolean;
  configId?: string;
  checked?: number;
  newItems?: number;
  posted?: number;
  seeded?: number;
  ignored?: number;
  error?: string;
};

export async function processDueSocialFeeds(
  supabase: SupabaseClient<any>,
  opts: { now?: Date; limit?: number } = {},
): Promise<FeedProcessResult[]> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - FEED_POLL_EVERY_MS).toISOString();
  const { data, error } = await supabase
    .from("sp_feed_config")
    .select("id, user_id, project_id, feed_type, feed_url, ignore_paths, last_checked_at")
    .eq("enabled", true)
    .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(opts.limit ?? 10);

  if (error) return [{ ok: false, error: error.message }];
  const results: FeedProcessResult[] = [];
  for (const config of (data ?? []) as FeedConfig[]) {
    results.push(await processSocialFeedConfig(supabase, config, { now }));
  }
  return results;
}

export async function processProjectSocialFeed(
  supabase: SupabaseClient<any>,
  projectId: string,
  opts: { now?: Date } = {},
): Promise<FeedProcessResult> {
  const { data: config, error } = await supabase
    .from("sp_feed_config")
    .select("id, user_id, project_id, feed_type, feed_url, ignore_paths, last_checked_at")
    .eq("project_id", projectId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!config) return { ok: false, error: "Feed autopost is not enabled." };
  return processSocialFeedConfig(supabase, config as FeedConfig, {
    now: opts.now ?? new Date(),
  });
}

async function processSocialFeedConfig(
  supabase: SupabaseClient<any>,
  config: FeedConfig,
  opts: { now: Date },
): Promise<FeedProcessResult> {
  const nowIso = opts.now.toISOString();
  const { data: claimed } = await supabase
    .from("sp_feed_config")
    .update({ status: "checking", last_checked_at: nowIso, last_error: null })
    .eq("id", config.id)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    return { ok: false, configId: config.id, error: "Could not claim feed check." };
  }

  try {
    const { data: project, error: projectErr } = await supabase
      .from("projects")
      .select("id, url")
      .eq("id", config.project_id)
      .maybeSingle();
    if (projectErr) throw new Error(projectErr.message);
    if (!project) throw new Error("Project not found.");

    const feedUrl = await resolveFeedUrl(config, project as ProjectRow);
    if (!feedUrl) {
      throw new Error(
        config.feed_type === "sitemap"
          ? "Could not detect a sitemap URL."
          : "Enter an RSS/Atom feed URL.",
      );
    }

    const fetched =
      config.feed_type === "sitemap"
        ? await fetchSitemapItems(feedUrl)
        : await fetchRssItems(feedUrl);
    const ignorePaths = normalizeIgnorePaths(config.ignore_paths ?? []);
    const items = dedupeItems(fetched).filter((item) => !isIgnored(item.url, ignorePaths));
    const ignored = fetched.length - items.length;

    const urls = items.map((item) => item.url);
    const existingUrls = new Set<string>();
    if (urls.length > 0) {
      const { data: existing, error: existingErr } = await supabase
        .from("sp_feed_item")
        .select("url")
        .eq("config_id", config.id)
        .in("url", urls);
      if (existingErr) throw new Error(existingErr.message);
      for (const row of existing ?? []) existingUrls.add(row.url as string);
    }

    const isFirstCheck = !config.last_checked_at && existingUrls.size === 0;
    const newItems = items.filter((item) => !existingUrls.has(item.url));
    if (newItems.length > 0) {
      const { error: insErr } = await supabase.from("sp_feed_item").insert(
        newItems.map((item) => ({
          config_id: config.id,
          user_id: config.user_id,
          project_id: config.project_id,
          url: item.url,
          title: item.title,
          published_at: item.publishedAt,
          status: "seen",
        })),
      );
      if (insErr && insErr.code !== "23505") throw new Error(insErr.message);
    }

    let posted = 0;
    if (!isFirstCheck && newItems.length > 0) {
      posted = await postFeedItems(supabase, config, newItems);
    }

    await supabase
      .from("sp_feed_config")
      .update({
        feed_url: feedUrl,
        status: "ok",
        last_success_at: nowIso,
        last_item_at: newestTimestamp(items) ?? null,
        last_error: null,
      })
      .eq("id", config.id);

    return {
      ok: true,
      configId: config.id,
      checked: items.length,
      newItems: newItems.length,
      posted,
      seeded: isFirstCheck ? newItems.length : 0,
      ignored,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("sp_feed_config")
      .update({ status: "error", last_error: message })
      .eq("id", config.id);
    return { ok: false, configId: config.id, error: message };
  }
}

async function postFeedItems(
  supabase: SupabaseClient<any>,
  config: FeedConfig,
  items: FeedItem[],
): Promise<number> {
  const { data: bindings, error: bindErr } = await supabase
    .from("sp_site_account")
    .select("account_id")
    .eq("project_id", config.project_id)
    .eq("user_id", config.user_id)
    .eq("enabled", true)
    .eq("auto", true);
  if (bindErr) throw new Error(bindErr.message);
  const accountIds = [...new Set((bindings ?? []).map((b) => b.account_id as string))];
  if (accountIds.length === 0) return 0;

  let posted = 0;
  for (const item of items) {
    const errors: string[] = [];
    for (const accountId of accountIds) {
      const result = await postViaAccount({
        supabase,
        userId: config.user_id,
        input: {
          accountId,
          text: renderFeedPost(item),
        },
        source: config.feed_type as PostSource,
        projectId: config.project_id,
      });
      if (result.ok) posted++;
      else errors.push(`${accountId}: ${result.error}`);
    }
    await supabase
      .from("sp_feed_item")
      .update({
        status: errors.length === 0 ? "posted" : "failed",
        posted_at: errors.length === 0 ? new Date().toISOString() : null,
        last_error: errors.length ? errors.join("; ").slice(0, 1000) : null,
      })
      .eq("config_id", config.id)
      .eq("url", item.url);
  }
  return posted;
}

function renderFeedPost(item: FeedItem): string {
  const url = item.url;
  const title = (item.title ?? "").trim();
  if (!title) return url;
  const max = 280;
  const room = max - url.length - 1;
  if (room <= 12) return url.slice(0, max);
  const renderedTitle =
    title.length > room ? `${title.slice(0, Math.max(0, room - 1)).trim()}…` : title;
  return `${renderedTitle}\n${url}`;
}

async function resolveFeedUrl(
  config: FeedConfig,
  project: ProjectRow,
): Promise<string | null> {
  const configured = (config.feed_url ?? "").trim();
  if (configured) return normalizeAbsoluteUrl(configured, project.url);
  if (config.feed_type === "sitemap") {
    return detectSitemapUrl(project.url);
  }
  return null;
}

async function fetchRssItems(feedUrl: string): Promise<FeedItem[]> {
  const xml = await fetchText(feedUrl);
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: FeedItem[] = [];

  $("item").each((_, el) => {
    if (items.length >= MAX_RSS_ITEMS) return false;
    const node = $(el);
    const link = node.children("link").first().text().trim();
    const title = cleanText(node.children("title").first().text());
    const publishedAt = parseDate(
      node.children("pubDate").first().text() ||
        node.children("dc\\:date").first().text() ||
        node.children("date").first().text(),
    );
    if (link) items.push({ url: link, title, publishedAt });
  });

  $("entry").each((_, el) => {
    if (items.length >= MAX_RSS_ITEMS) return false;
    const node = $(el);
    const link =
      node.children("link[rel='alternate']").first().attr("href") ??
      node.children("link").first().attr("href") ??
      node.children("id").first().text().trim();
    const title = cleanText(node.children("title").first().text());
    const publishedAt = parseDate(
      node.children("published").first().text() ||
        node.children("updated").first().text(),
    );
    if (link) items.push({ url: link, title, publishedAt });
  });

  return items.map((item) => ({ ...item, url: normalizeAbsoluteUrl(item.url, feedUrl) }));
}

async function fetchSitemapItems(sitemapUrl: string): Promise<FeedItem[]> {
  const xml = await fetchText(sitemapUrl);
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($("sitemapindex").length > 0) {
    const childUrls = $("sitemap loc")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .slice(0, 10);
    const nested: FeedItem[] = [];
    for (const child of childUrls) {
      nested.push(...(await fetchSitemapItems(normalizeAbsoluteUrl(child, sitemapUrl))));
      if (nested.length >= MAX_SITEMAP_URLS) break;
    }
    return nested.slice(0, MAX_SITEMAP_URLS);
  }

  const items: FeedItem[] = [];
  $("url").each((_, el) => {
    if (items.length >= MAX_SITEMAP_URLS) return false;
    const node = $(el);
    const loc = node.children("loc").first().text().trim();
    if (!loc) return;
    const publishedAt = parseDate(node.children("lastmod").first().text());
    items.push({
      url: normalizeAbsoluteUrl(loc, sitemapUrl),
      title: titleFromUrl(loc),
      publishedAt,
    });
  });
  return items;
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5",
        "user-agent": USER_AGENT,
      },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function dedupeItems(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const item of items) {
    const url = item.url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...item, url });
  }
  return out;
}

function normalizeIgnorePaths(paths: string[]): string[] {
  return paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => (path.startsWith("/") ? path : `/${path}`));
}

function isIgnored(rawUrl: string, ignorePaths: string[]): boolean {
  if (ignorePaths.length === 0) return false;
  let path = rawUrl;
  try {
    const url = new URL(rawUrl);
    path = url.pathname;
  } catch {
    // Keep raw string fallback.
  }
  return ignorePaths.some((ignore) => path === ignore || path.startsWith(`${ignore}/`));
}

function normalizeAbsoluteUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw.trim();
  }
}

function titleFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (!last) return url.hostname;
    return cleanText(decodeURIComponent(last).replace(/[-_]+/g, " "));
  } catch {
    return null;
  }
}

function cleanText(text: string): string | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function parseDate(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function newestTimestamp(items: FeedItem[]): string | null {
  let newest = 0;
  for (const item of items) {
    if (!item.publishedAt) continue;
    const ms = Date.parse(item.publishedAt);
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest ? new Date(newest).toISOString() : null;
}
