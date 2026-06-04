import * as cheerio from "cheerio";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { detectSitemapUrl } from "@/lib/lx/sitemap";
import { postViaAccount, type PostSource } from "@/lib/sp/post";
import {
  assemblePostText,
  renderPostForPlatform,
  type ProjectSocialConfig,
  type RenderedPost,
} from "@/lib/sp/renderPost";
import {
  resolveImage,
  resolveImageStyle,
  shouldAttachImage,
  type ImageStylePref,
} from "@/lib/sp/imageGen";

export type FeedAutopostClients = {
  anthropic?: Anthropic | null;
  openai?: OpenAI | null;
};

const USER_AGENT = "CrawlProofSocialFeed/1.0";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_RSS_ITEMS = 50;
const MAX_SITEMAP_URLS = 500;
const FEED_POLL_EVERY_MS = 15 * 60 * 1000;

// Per-(user, platform) cap on autoposted feed items, across every project
// that user owns. Manual posts are not counted. When the gate fires the
// item stays 'seen' and is picked up by the next sweep after the window
// closes — items are not dropped.
export const POST_THROTTLE_MS = 4 * 60 * 60 * 1000;
const FEED_SOURCES: ReadonlyArray<PostSource> = ["rss", "sitemap"];

async function platformAccountIds(
  supabase: SupabaseClient<any>,
  userId: string,
  platform: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("sp_account")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", platform);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

async function lastFeedPostOnPlatform(
  supabase: SupabaseClient<any>,
  userId: string,
  platform: string,
): Promise<Date | null> {
  const accountIds = await platformAccountIds(supabase, userId, platform);
  if (accountIds.length === 0) return null;
  const cutoff = new Date(Date.now() - POST_THROTTLE_MS).toISOString();
  const { data } = await supabase
    .from("sp_post")
    .select("created_at")
    .eq("user_id", userId)
    .in("account_id", accountIds)
    .in("source", FEED_SOURCES as unknown as string[])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return new Date(data.created_at as string);
}

// Public helper for the Schedule UI: returns next-allowed-post time per
// platform that the user has at least one autopost binding for. A
// platform with no recent post is omitted (it's ready right now).
export async function nextPlatformReleases(
  supabase: SupabaseClient<any>,
  userId: string,
  platforms: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const platform of platforms) {
    const last = await lastFeedPostOnPlatform(supabase, userId, platform);
    if (!last) continue;
    const nextMs = last.getTime() + POST_THROTTLE_MS;
    if (nextMs <= Date.now()) continue;
    out[platform] = new Date(nextMs).toISOString();
  }
  return out;
}

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

export type ProgressCallback = (msg: string) => void;

export async function processDueSocialFeeds(
  supabase: SupabaseClient<any>,
  opts: { now?: Date; limit?: number; clients?: FeedAutopostClients } = {},
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
    results.push(
      await processSocialFeedConfig(supabase, config, {
        now,
        clients: opts.clients,
      }),
    );
  }
  return results;
}

export async function processProjectSocialFeed(
  supabase: SupabaseClient<any>,
  projectId: string,
  opts: { now?: Date; clients?: FeedAutopostClients; onProgress?: ProgressCallback } = {},
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
    clients: opts.clients,
    onProgress: opts.onProgress,
  });
}

async function processSocialFeedConfig(
  supabase: SupabaseClient<any>,
  config: FeedConfig,
  opts: { now: Date; clients?: FeedAutopostClients; onProgress?: ProgressCallback },
): Promise<FeedProcessResult> {
  const progress = opts.onProgress ?? (() => {});
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

    progress("Resolving feed URL…");
    const feedUrl = await resolveFeedUrl(config, project as ProjectRow);
    if (!feedUrl) {
      throw new Error(
        config.feed_type === "sitemap"
          ? "Could not detect a sitemap URL."
          : "Enter an RSS/Atom feed URL.",
      );
    }

    progress(`Fetching ${config.feed_type === "sitemap" ? "sitemap" : "RSS"} feed…`);
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
      // On the very first check, the items already in the feed are
      // historical — flag them 'ignored' so the drain loop doesn't post
      // a backlog of old URLs at 1-per-4h.
      const insertStatus = isFirstCheck ? "ignored" : "seen";
      const { error: insErr } = await supabase.from("sp_feed_item").insert(
        newItems.map((item) => ({
          config_id: config.id,
          user_id: config.user_id,
          project_id: config.project_id,
          url: item.url,
          title: item.title,
          published_at: item.publishedAt,
          status: insertStatus,
        })),
      );
      if (insErr && insErr.code !== "23505") throw new Error(insErr.message);
    }

    progress(
      `Checked ${items.length} item(s)${newItems.length > 0 ? `, ${newItems.length} new` : ", nothing new"}…`,
    );

    // Drain pending items regardless of whether this sweep added any —
    // earlier sweeps may have left 'seen' rows that couldn't ship
    // because their platform was inside the 4h throttle window.
    let posted = 0;
    if (!isFirstCheck) {
      posted = await drainPendingFeedItems(supabase, config, opts.clients ?? {}, progress);
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

type FeedItemRow = {
  id: string;
  url: string;
  title: string | null;
  published_at: string | null;
  delivered_platforms: string[] | null;
  rendered_per_platform: Record<string, RenderedPost> | null;
  image_url: string | null;
  image_source: "og" | "ai" | null;
};

type LoadedProjectConfig = ProjectSocialConfig & {
  image_cadence: number;
  image_style: ImageStylePref;
};

const DEFAULT_PROJECT_CONFIG: LoadedProjectConfig = {
  brand_voice: "",
  tone: "casual",
  default_hashtags: [],
  custom_instructions: "",
  image_cadence: 0,
  image_style: "editorial",
};

async function loadProjectConfig(
  supabase: SupabaseClient<any>,
  projectId: string,
): Promise<LoadedProjectConfig> {
  const { data } = await supabase
    .from("sp_project_config")
    .select(
      "brand_voice, tone, default_hashtags, custom_instructions, image_cadence, image_style",
    )
    .eq("project_id", projectId)
    .maybeSingle();
  if (!data) return DEFAULT_PROJECT_CONFIG;
  return {
    brand_voice: (data.brand_voice as string | null) ?? "",
    tone: (data.tone as string | null) ?? "casual",
    default_hashtags: (data.default_hashtags as string[] | null) ?? [],
    custom_instructions: (data.custom_instructions as string | null) ?? "",
    image_cadence: (data.image_cadence as number | null) ?? 0,
    image_style: ((data.image_style as string | null) ?? "editorial") as ImageStylePref,
  };
}

// Drain the 'seen' backlog for this config, one item per platform per
// 4h. Items not yet delivered to every bound platform stay in 'seen'
// state so future sweeps pick them up after the throttle window passes.
async function drainPendingFeedItems(
  supabase: SupabaseClient<any>,
  config: FeedConfig,
  clients: FeedAutopostClients,
  progress: ProgressCallback = () => {},
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

  const { data: accountRows } = await supabase
    .from("sp_account")
    .select("id, handle, platform")
    .in("id", accountIds);
  const accounts = ((accountRows ?? []) as Array<{
    id: string;
    handle: string;
    platform: string;
  }>);
  const platforms = [...new Set(accounts.map((a) => a.platform))];

  const projectConfig = await loadProjectConfig(supabase, config.project_id);

  let posted = 0;
  for (const platform of platforms) {
    const last = await lastFeedPostOnPlatform(supabase, config.user_id, platform);
    if (last && Date.now() - last.getTime() < POST_THROTTLE_MS) continue;

    const item = await findOldestUndeliveredItem(supabase, config.id, platform);
    if (!item) continue;

    progress(`Processing item for ${platform}…`);

    // Sitemap feeds carry no titles, so item.title is derived from the URL
    // slug (e.g. a UUID). Fetch the real page <title>/og:title so the render
    // has good input — and persist it so history shows the real title.
    if (config.feed_type === "sitemap" && !item.rendered_per_platform) {
      progress(`Fetching page title for ${platform}…`);
      const real = await fetchPageTitle(item.url);
      if (real && real !== item.title) {
        await supabase.from("sp_feed_item").update({ title: real }).eq("id", item.id);
        item.title = real;
      }
    }

    // 1. Make sure we have an LLM render for this (item, platform). If the
    // render can't be produced, mark the item failed (retryable) and move on
    // rather than posting a raw title+url spam fallback.
    let rendered: RenderedPost;
    try {
      progress(`Rendering post for ${platform}…`);
      rendered = await ensureRendered({
        supabase,
        item,
        platform,
        url: item.url,
        title: item.title,
        config: projectConfig,
        anthropic: clients.anthropic ?? null,
        openai: clients.openai ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sp] render failed for ${platform} (${item.url}): ${msg}`);
      await supabase
        .from("sp_feed_item")
        .update({ status: "failed", last_error: `render: ${msg}`.slice(0, 1000) })
        .eq("id", item.id);
      continue;
    }

    // 2. Make sure we have an image resolved (og or ai) if cadence says so.
    const imageUrl = await ensureImage({
      supabase,
      item,
      cadence: projectConfig.image_cadence,
      brandVoice: projectConfig.brand_voice,
      style: projectConfig.image_style,
      openai: clients.openai ?? null,
    });

    // 3. Assemble platform-appropriate post text.
    const text = assemblePostText({ rendered, url: item.url, platform });

    const platformAccounts = accounts.filter((a) => a.platform === platform);
    const errors: string[] = [];
    for (const account of platformAccounts) {
      progress(`Posting to ${platform} (@${account.handle})…`);
      const result = await postViaAccount({
        supabase,
        userId: config.user_id,
        input: {
          accountId: account.id,
          text,
          title: rendered.title,
          mediaUrl: imageUrl ? [imageUrl] : undefined,
        },
        source: config.feed_type as PostSource,
        projectId: config.project_id,
      });
      if (!result.ok) errors.push(`${account.handle}: ${result.error}`);
    }

    if (errors.length === platformAccounts.length) {
      await supabase
        .from("sp_feed_item")
        .update({
          status: "failed",
          last_error: errors.join("; ").slice(0, 1000),
        })
        .eq("id", item.id);
      continue;
    }

    const delivered = [
      ...new Set([...((item.delivered_platforms ?? []) as string[]), platform]),
    ];
    const complete = platforms.every((p) => delivered.includes(p));
    await supabase
      .from("sp_feed_item")
      .update({
        delivered_platforms: delivered,
        status: complete ? "posted" : "seen",
        posted_at: complete ? new Date().toISOString() : null,
        last_error: errors.length ? errors.join("; ").slice(0, 1000) : null,
      })
      .eq("id", item.id);
    posted++;
  }
  return posted;
}

async function ensureRendered(args: {
  supabase: SupabaseClient<any>;
  item: FeedItemRow;
  platform: string;
  url: string;
  title: string | null;
  config: ProjectSocialConfig;
  anthropic: Anthropic | null;
  openai: OpenAI | null;
}): Promise<RenderedPost> {
  const { supabase, item, platform, url, title, config, anthropic, openai } = args;
  const cache = (item.rendered_per_platform ?? {}) as Record<string, RenderedPost>;
  if (cache[platform]) return cache[platform];

  // Throws on failure (no provider / model error / empty). The caller marks
  // the item failed (retryable) — we never post a raw "title\nurl" fallback.
  const rendered = await renderPostForPlatform({
    anthropic,
    openai,
    platform,
    url,
    articleTitle: title,
    config,
  });

  const next = { ...cache, [platform]: rendered };
  await supabase
    .from("sp_feed_item")
    .update({ rendered_per_platform: next })
    .eq("id", item.id);
  item.rendered_per_platform = next;
  return rendered;
}

async function ensureImage(args: {
  supabase: SupabaseClient<any>;
  item: FeedItemRow;
  cadence: number;
  brandVoice: string;
  style: ImageStylePref;
  openai: OpenAI | null;
}): Promise<string | null> {
  const { supabase, item, cadence, brandVoice, style, openai } = args;
  if (item.image_url) return item.image_url;
  if (!shouldAttachImage(item.id, cadence)) return null;
  const attached = await resolveImage({
    supabase,
    openai,
    feedItemId: item.id,
    articleUrl: item.url,
    articleTitle: item.title ?? item.url,
    brandVoice,
    // "rotate" resolves to a concrete style deterministically per item.
    style: resolveImageStyle(style, item.id),
    // AI generation only if cadence is on AND an OpenAI client is available.
    allowAi: !!openai,
  });
  if (!attached) return null;
  await supabase
    .from("sp_feed_item")
    .update({ image_url: attached.url, image_source: attached.source })
    .eq("id", item.id);
  item.image_url = attached.url;
  item.image_source = attached.source;
  return attached.url;
}

async function findOldestUndeliveredItem(
  supabase: SupabaseClient<any>,
  configId: string,
  platform: string,
): Promise<FeedItemRow | null> {
  // Oldest-first so backlog drains predictably. Pull a small window and
  // pick the first one whose delivered_platforms doesn't already include
  // this platform — filtering server-side via .not("delivered_platforms",
  // "cs", `{${platform}}`) is brittle across PostgREST versions, so we
  // do the contains check in app code.
  const { data } = await supabase
    .from("sp_feed_item")
    .select(
      "id, url, title, published_at, delivered_platforms, rendered_per_platform, image_url, image_source",
    )
    .eq("config_id", configId)
    .eq("status", "seen")
    .order("first_seen_at", { ascending: true })
    .limit(20);
  const rows = (data ?? []) as FeedItemRow[];
  return (
    rows.find(
      (r) => !((r.delivered_platforms ?? []) as string[]).includes(platform),
    ) ?? null
  );
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

// Fetch a page's real title (og:title or <title>). Used for sitemap feeds
// whose items have no title (only a URL-slug fallback).
async function fetchPageTitle(url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "text/html,*/*;q=0.5", "user-agent": USER_AGENT },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/html")) return null;
    const html = (await res.text()).slice(0, 200_000);
    const $ = cheerio.load(html);
    const og = $('meta[property="og:title"]').attr("content")?.trim();
    const title = $("title").first().text().trim();
    return cleanText(og || title || "");
  } catch {
    return null;
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
