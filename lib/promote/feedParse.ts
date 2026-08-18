// RSS/Atom parsing for Promote content sources.
//
// The social-feed engine already parses feeds (lib/sp/feedAutopost.ts), but it
// only needs a URL, a title and a date. Promote needs enough to write a pitch
// without re-fetching the page — summary, image, author, and a stable guid for
// dedupe — so it gets its own parser rather than widening that one.
//
// cheerio in xmlMode is the house pattern for feed XML here.

import * as cheerio from "cheerio";

const MAX_SUMMARY_LENGTH = 600;

export type ParsedFeedItem = {
  url: string;
  title: string | null;
  summary: string | null;
  /** The publisher's own id for the entry, when it gives one. */
  guid: string | null;
  imageUrl: string | null;
  author: string | null;
  /**
   * The publication the entry came from. Aggregator feeds (RSS Amplifier topic
   * feeds among them) name the original publisher in <source>; shared content
   * is attributed with this rather than with the aggregator's own name.
   */
  sourceName: string | null;
  publishedAt: string | null;
};

export type ParsedFeed = {
  /** The feed's own title, used to attribute shared content. */
  title: string | null;
  items: ParsedFeedItem[];
};

/**
 * Parse an RSS or Atom document. Unknown or malformed documents yield an empty
 * item list rather than throwing — a bad feed should pause one source, not
 * take down an ingestion sweep.
 */
export function parseFeed(xml: string, feedUrl: string, maxItems = 50): ParsedFeed {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return { title: null, items: [] };
  }

  const feedTitle =
    cleanText($("channel > title").first().text()) ??
    cleanText($("feed > title").first().text());

  const items: ParsedFeedItem[] = [];

  $("item").each((_, el) => {
    if (items.length >= maxItems) return false;
    const node = $(el);
    const link = node.children("link").first().text().trim();
    const guid = node.children("guid").first().text().trim() || null;
    const url = absolutize(link || guid || "", feedUrl);
    if (!url) return;
    items.push({
      url,
      title: cleanText(node.children("title").first().text()),
      summary: summarize(
        node.children("content\\:encoded").first().text() ||
          node.children("description").first().text(),
      ),
      guid,
      imageUrl: itemImage($, node, feedUrl),
      author:
        cleanText(node.children("dc\\:creator").first().text()) ??
        cleanText(node.children("author").first().text()),
      sourceName: cleanText(node.children("source").first().text()),
      publishedAt: parseDate(
        node.children("pubDate").first().text() ||
          node.children("dc\\:date").first().text() ||
          node.children("date").first().text(),
      ),
    });
    return;
  });

  $("entry").each((_, el) => {
    if (items.length >= maxItems) return false;
    const node = $(el);
    const link =
      node.children("link[rel='alternate']").first().attr("href") ??
      node.children("link").first().attr("href") ??
      node.children("id").first().text().trim();
    const url = absolutize(link ?? "", feedUrl);
    if (!url) return;
    items.push({
      url,
      title: cleanText(node.children("title").first().text()),
      summary: summarize(
        node.children("summary").first().text() ||
          node.children("content").first().text(),
      ),
      guid: node.children("id").first().text().trim() || null,
      imageUrl: itemImage($, node, feedUrl),
      author: cleanText(node.children("author").first().children("name").first().text()),
      sourceName: cleanText(node.children("source").first().children("title").first().text()),
      publishedAt: parseDate(
        node.children("published").first().text() ||
          node.children("updated").first().text(),
      ),
    });
    return;
  });

  return { title: feedTitle, items };
}

function itemImage(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<never> | ReturnType<cheerio.CheerioAPI>,
  feedUrl: string,
): string | null {
  const candidates = [
    node.children("media\\:content").first().attr("url"),
    node.children("media\\:thumbnail").first().attr("url"),
    node.children("enclosure[type^='image']").first().attr("url"),
    node.children("image").first().text().trim(),
  ];
  for (const candidate of candidates) {
    const url = absolutize((candidate ?? "").trim(), feedUrl);
    if (url) return url;
  }
  // Last resort: the first <img> inside the rendered body.
  const body =
    node.children("content\\:encoded").first().text() ||
    node.children("description").first().text() ||
    node.children("content").first().text();
  if (body) {
    const match = body.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return absolutize(match[1], feedUrl);
  }
  return null;
}

/** Strip markup and entities out of feed prose, then trim it to a usable length. */
export function summarize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  // Prefer cutting at a word boundary so the summary does not end mid-word.
  const clipped = text.slice(0, MAX_SUMMARY_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > MAX_SUMMARY_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim() + "…";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:#3[49]|quot|apos);/g, (m) => (m === "&quot;" || m === "&#34;" ? '"' : "'"))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function cleanText(text: string | null | undefined): string | null {
  const trimmed = decodeEntities(text ?? "").replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function absolutize(raw: string, base: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseDate(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}
