// Free business search — the zero-cost lead source.
//
// CrawlProof holds a ValueSERP key and that stays the primary path (better
// local-business coverage, structured JSON, nothing to scrape). This is the
// fallback that keeps a campaign discovering when the key is absent, its
// quota is spent, or a query comes back empty.
//
// Two engines, tried in order, because free search endpoints are a moving
// target. DuckDuckGo's HTML endpoint currently answers HTTP 202 with an
// anti-bot challenge from datacentre IPs — kept first because it works from a
// residential host and these blocks come and go. Mojeek is the one that
// actually serves us today: its own index, direct hrefs, no challenge.
//
// Every failure is soft. An empty result set means a campaign discovers
// nothing this tick, not a crash, and the caller falls through to ValueSERP.

import * as cheerio from "cheerio";
import { normalizeHost } from "./cold";

export type BusinessResult = {
  name: string;
  url: string;
  host: string;
  snippet: string;
  /** Which backend served this row — surfaced so a dead engine is visible. */
  engine: "duckduckgo" | "mojeek";
};

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/**
 * DDG wraps destinations in a redirect:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=…
 * Unwrap it, or every "lead" is duckduckgo.com.
 */
export function unwrapDdgUrl(href: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (/duckduckgo\.com$/.test(url.hostname) && url.pathname.startsWith("/l/")) {
      const target = url.searchParams.get("uddg");
      return target ? decodeURIComponent(target) : null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseDdgHtml(html: string): BusinessResult[] {
  const $ = cheerio.load(html);
  const out: BusinessResult[] = [];
  const seen = new Set<string>();

  const push = (href: string, name: string, snippet: string) => {
    const target = unwrapDdgUrl(href);
    if (!target) return;
    const host = normalizeHost(target);
    if (!host || seen.has(host)) return;
    seen.add(host);
    out.push({ name: name || host, url: target, host, snippet, engine: "duckduckgo" });
  };

  $(".result, .web-result").each((_, el) => {
    const link = $(el).find("a.result__a").first();
    push(
      link.attr("href") ?? "",
      link.text().replace(/\s+/g, " ").trim(),
      $(el).find(".result__snippet").text().replace(/\s+/g, " ").trim().slice(0, 300),
    );
  });

  // Layout fallback, and the shape the /lite endpoint returns.
  if (!out.length) {
    $("a.result__a, a.result-link").each((_, el) => {
      push($(el).attr("href") ?? "", $(el).text().replace(/\s+/g, " ").trim(), "");
    });
  }

  return out;
}

/**
 * Mojeek: `<li><a class="ob" href="URL">…</a><h2><a class="title">Title</a></h2>
 * <p class="s">snippet</p></li>`. Direct hrefs, no redirect wrapper.
 */
export function parseMojeekHtml(html: string): BusinessResult[] {
  const $ = cheerio.load(html);
  const out: BusinessResult[] = [];
  const seen = new Set<string>();

  const collect = (selector: string) => {
    $(selector).each((_, el) => {
      const link = $(el).find("h2 a").first();
      const href = (link.attr("href") ?? $(el).find("a.ob").first().attr("href") ?? "").trim();
      if (!href || href.startsWith("/")) return;
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      const host = normalizeHost(url.hostname);
      if (!host || seen.has(host)) return;
      seen.add(host);
      out.push({
        name: link.text().replace(/\s+/g, " ").trim() || host,
        url: url.toString(),
        host,
        snippet: $(el).find("p.s").text().replace(/\s+/g, " ").trim().slice(0, 300),
        engine: "mojeek",
      });
    });
  };

  collect("ul.results-standard li");
  // Layout-independent fallback: any list item carrying a headline link. The
  // wrapper class has changed before; the h2 > a shape has not.
  if (!out.length) collect("li:has(h2 a)");

  return out;
}

async function tryDuckDuckGo(query: string, region: string): Promise<BusinessResult[]> {
  for (const endpoint of ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"]) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "user-agent": BROWSER_UA,
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
        },
        body: new URLSearchParams({ q: query, kl: region }),
        signal: AbortSignal.timeout(15_000),
      });
      // 202 is DDG's anti-bot challenge, not a result page.
      if (res.status === 202 || !res.ok) continue;
      const parsed = parseDdgHtml(await res.text());
      if (parsed.length) return parsed;
    } catch {
      // Try the next endpoint.
    }
  }
  return [];
}

async function tryMojeek(query: string): Promise<{ results: BusinessResult[]; note?: string }> {
  try {
    const res = await fetch(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    // Mojeek serves the first query from an IP and then 403s for a while.
    // Say so rather than reporting "no results", which sends the caller off
    // rewriting a query that was fine.
    if (res.status === 403 || res.status === 429) {
      return { results: [], note: `Mojeek rate-limited this IP (HTTP ${res.status})` };
    }
    if (!res.ok) return { results: [], note: `Mojeek returned HTTP ${res.status}` };
    return { results: parseMojeekHtml(await res.text()) };
  } catch (err) {
    return { results: [], note: `Mojeek: ${err instanceof Error ? err.message : "request failed"}` };
  }
}

export async function businessSearch(input: {
  query: string;
  limit?: number;
  /** DDG region code, e.g. "us-en", "uk-en". Ignored by Mojeek. */
  region?: string;
}): Promise<{ results: BusinessResult[]; error?: string }> {
  const limit = Math.min(input.limit ?? 10, 50);

  const ddg = await tryDuckDuckGo(input.query, input.region ?? "us-en");
  if (ddg.length) return { results: ddg.slice(0, limit) };

  const mojeek = await tryMojeek(input.query);
  if (mojeek.results.length) return { results: mojeek.results.slice(0, limit) };

  return {
    results: [],
    error: [
      "No free engine returned results.",
      "DuckDuckGo answers its anti-bot challenge (HTTP 202) from datacentre IPs.",
      mojeek.note ?? "Mojeek returned nothing.",
      "Free search is best-effort from a server; set VALUESERP_API_KEY for reliable discovery.",
    ].join(" "),
  };
}
