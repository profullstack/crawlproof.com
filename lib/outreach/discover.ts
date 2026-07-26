// Prospect discovery — where leads actually come from.
//
// Without this the outreach toolset is a nicer way to email people you
// already found, which is not lead generation. Two sources, both of which
// produce a business that owns a website we can scan:
//
//   search  — a Google query through the ValueSERP key CrawlProof already
//             holds ("dentists in Austin", "SaaS pricing page"), taking the
//             domain behind each organic result.
//   seed    — a page that already lists the businesses you want: a directory,
//             a "best X in Y" listicle, a conference sponsor page, a
//             marketplace category. Every outbound link is a candidate.
//
// Deliberately absent: purchased contact databases. Beyond the licensing
// question, scraped B2B lists are stale, and a bounced cold email costs more
// deliverability than the lead was worth. Everything here resolves to a live
// domain we then scan ourselves.

import * as cheerio from "cheerio";
import { searchSerp, hasValueSerpKey } from "@/lib/alerts/valueserp";
import { isThirdPartyHost } from "@/lib/leadCampaign";
import { businessSearch } from "./freeSearch";
import { normalizeHost } from "./cold";

export type DiscoveredProspect = {
  host: string;
  url: string;
  /** How we found it, kept for the record and for debugging a bad campaign. */
  via: "search" | "seed";
  /** SERP title or link text — the only thing we know before scanning. */
  label: string;
  source: string;
};

/**
 * Hosts that are never a prospect: platforms, aggregators, and the places
 * directory pages link to alongside the businesses. A listicle about local
 * dentists links to Yelp, Google Maps and Facebook on every row, and without
 * this the top "prospects" of every campaign are the same six sites.
 */
const NON_PROSPECT_HOSTS = [
  "yelp.com", "tripadvisor.com", "mapquest.com", "bbb.org", "angi.com",
  "thumbtack.com", "houzz.com", "zillow.com", "indeed.com", "glassdoor.com",
  "crunchbase.com", "producthunt.com", "g2.com", "capterra.com", "trustpilot.com",
  "wikipedia.org", "wordpress.com", "wixsite.com", "squarespace.com", "shopify.com",
  "eventbrite.com", "meetup.com", "substack.com", "medium.com", "blogspot.com",
  "godaddy.com", "cloudflare.com", "gstatic.com", "googleapis.com", "w3.org",
  "schema.org", "archive.org", "youtu.be", "bit.ly", "goo.gl", "t.co",
];

/** File extensions that mean the link is an asset, not a business. */
const ASSET_RE = /\.(pdf|jpe?g|png|gif|svg|webp|mp4|zip|css|js|xml|rss)$/i;

export function isNonProspectHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h || !h.includes(".")) return true;
  if (isThirdPartyHost(h)) return true;
  const apex = h.split(".").slice(-2).join(".");
  return NON_PROSPECT_HOSTS.some((n) => h === n || apex === n || h.endsWith(`.${n}`));
}

/**
 * Pull candidate business domains out of a directory or listicle page.
 *
 * Only outbound links count — internal navigation on a directory is the
 * directory itself. One entry per host, keeping the first link text seen,
 * which on a directory page is almost always the business name.
 */
export function extractOutboundProspects(input: {
  html: string;
  sourceUrl: string;
  limit?: number;
}): DiscoveredProspect[] {
  const $ = cheerio.load(input.html);
  const sourceHost = normalizeHost(input.sourceUrl);
  const out = new Map<string, DiscoveredProspect>();

  $("a[href]").each((_, el) => {
    if (out.size >= (input.limit ?? 100)) return false;
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return undefined;
    }
    let url: URL;
    try {
      url = new URL(href, input.sourceUrl);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (ASSET_RE.test(url.pathname)) return undefined;

    const host = normalizeHost(url.hostname);
    if (!host || host === sourceHost || out.has(host)) return undefined;
    if (isNonProspectHost(host)) return undefined;

    const label = ($(el).attr("title") ?? $(el).text() ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    out.set(host, {
      host,
      url: `https://${host}`,
      via: "seed",
      label: label || host,
      source: input.sourceUrl,
    });
    return undefined;
  });

  return [...out.values()];
}

export async function discoverFromSeed(input: {
  seedUrl: string;
  limit?: number;
}): Promise<{ prospects: DiscoveredProspect[]; error?: string }> {
  try {
    const res = await fetch(input.seedUrl, {
      headers: { "user-agent": "CrawlProofOutreach/1.0 (+https://crawlproof.com)" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return { prospects: [], error: `seed ${input.seedUrl} returned HTTP ${res.status}` };
    const html = await res.text();
    return { prospects: extractOutboundProspects({ html, sourceUrl: input.seedUrl, limit: input.limit }) };
  } catch (err) {
    return {
      prospects: [],
      error: `seed ${input.seedUrl} failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

/** Which search backend to use. */
export type SearchSource = "auto" | "serp" | "free" | "both";

/**
 * Search discovery.
 *
 * ValueSERP is the default when its key is present: Google's index has the
 * best local-business coverage, and the results arrive as structured JSON
 * instead of scraped HTML that shifts under us. The free engines
 * (DuckDuckGo, then Mojeek — see freeSearch.ts) are the fallback, and stay
 * useful on their own: they index a different slice of the web, so "both"
 * genuinely widens the funnel rather than repeating it.
 *
 * `calls` counts billable ValueSERP searches so a campaign's cost stays
 * visible in the tick summary.
 */
export async function discoverFromSearch(input: {
  query: string;
  limit?: number;
  source?: SearchSource;
}): Promise<{ prospects: DiscoveredProspect[]; calls: number; error?: string }> {
  const limit = Math.min(input.limit ?? 30, 100);
  const source = input.source ?? "auto";
  const out = new Map<string, DiscoveredProspect>();
  const errors: string[] = [];
  let calls = 0;

  const wantSerp = (source === "auto" || source === "serp" || source === "both") && hasValueSerpKey();
  const wantFree = source === "free" || source === "both" || (source === "auto" && !hasValueSerpKey());

  if (wantSerp) {
    const res = await searchSerp({ query: input.query, recency: "any", num: limit });
    calls += res.calls;
    if (!res.ok) errors.push(res.error ?? "ValueSERP failed");
    for (const r of res.results) {
      const host = normalizeHost(r.domain || r.url);
      if (!host || out.has(host) || isNonProspectHost(host)) continue;
      out.set(host, {
        host,
        url: `https://${host}`,
        via: "search",
        label: r.title || host,
        source: `serp:${input.query}`,
      });
    }
  }

  // Also run the free engines when SERP came back empty — an exhausted quota
  // or a bad query shouldn't stall a campaign that has a free source too.
  if (wantFree || (wantSerp && !out.size)) {
    const free = await businessSearch({ query: input.query, limit });
    if (free.error) errors.push(free.error);
    for (const r of free.results) {
      if (out.has(r.host) || isNonProspectHost(r.host)) continue;
      out.set(r.host, {
        host: r.host,
        url: r.url,
        via: "search",
        label: r.name || r.host,
        source: `${r.engine}:${input.query}`,
      });
    }
  }

  if (!out.size && source === "serp" && !hasValueSerpKey()) {
    errors.push("VALUESERP_API_KEY is not set.");
  }
  return {
    prospects: [...out.values()],
    calls,
    error: out.size ? undefined : errors.join("; ") || "no results",
  };
}

/** Run every configured source for a campaign and merge the results. */
export async function discoverProspects(input: {
  queries?: string[];
  seedUrls?: string[];
  limit?: number;
  source?: SearchSource;
}): Promise<{ prospects: DiscoveredProspect[]; serpCalls: number; errors: string[] }> {
  const limit = input.limit ?? 50;
  const merged = new Map<string, DiscoveredProspect>();
  const errors: string[] = [];
  let serpCalls = 0;

  const queries = (input.queries ?? []).slice(0, 5);
  for (const [i, query] of queries.entries()) {
    // Space out the free engines: Mojeek serves the first query from an IP
    // and 403s the rest of a burst. Costs a second, keeps discovery working.
    if (i > 0) await new Promise((r) => setTimeout(r, 1_500));
    const res = await discoverFromSearch({ query, limit, source: input.source });
    serpCalls += res.calls;
    if (res.error) errors.push(res.error);
    for (const p of res.prospects) if (!merged.has(p.host)) merged.set(p.host, p);
    if (merged.size >= limit) break;
  }

  for (const seedUrl of (input.seedUrls ?? []).slice(0, 10)) {
    if (merged.size >= limit) break;
    const res = await discoverFromSeed({ seedUrl, limit });
    if (res.error) errors.push(res.error);
    for (const p of res.prospects) if (!merged.has(p.host)) merged.set(p.host, p);
  }

  return { prospects: [...merged.values()].slice(0, limit), serpCalls, errors };
}
