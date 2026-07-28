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
import { loadSeedCredential, makeSeedCodeWaiter, recordSeedCredentialResult, seedHost } from "./seedCredentials";
import type { CodeWaiter } from "@/lib/sp/verificationChallenge";
import { looksLikeLoginWall } from "./loginWall";
import type { SeedCredentials } from "./seedLogin";

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
  // Creative platforms and marketplaces. A profile on one of these is not a
  // site the artist owns, and the outreach pipeline needs a domain they do.
  "artstation.com", "behance.net", "adobe.com", "dribbble.com", "deviantart.com",
  "sketchfab.com", "cgtrader.com", "turbosquid.com", "cults3d.com", "gumroad.com",
  "upwork.com", "fiverr.com", "freelancer.com", "peopleperhour.com", "toptal.com",
  "polywork.com", "contra.com", "patreon.com", "ko-fi.com", "buymeacoffee.com",
  // Communities, showcases and trade press that dominate these searches.
  "blenderartists.org", "polycount.com", "cgsociety.org", "therookies.co",
  "80.lv", "cgchannel.com", "gamedeveloper.com", "gamasutra.com", "wingfox.com",
  "unrealengine.com", "unity.com", "blender.org", "autodesk.com", "maxon.net",
  "itch.io", "gamejolt.com", "steampowered.com",
  // Art and games schools whose domains give no hint of what they are. The
  // patterns above catch anything with "academy" or ".edu" in it; these have
  // to be named, and anything similar that turns up will need adding too.
  "vanarts.com", "cgspectrum.com", "thinktankonline.com", "animationmentor.com",
  "fxphd.com", "syn-studio.com", "lostboys-studios.com",
];

/**
 * Categories of site that keep surfacing for portfolio-shaped searches and are
 * never the person you were looking for.
 *
 * Searching for "3d artist portfolio" reliably returns the industry around
 * artists rather than artists: the school that teaches them, the forum where
 * they post, the marketplace that hosts them, the magazine that covers them.
 * Every one of those has a contact address, so without this they sail through
 * discovery and a campaign ends up cold-emailing a university.
 *
 * Matched on the host, so a personal site is only caught if its own domain
 * says school or forum or wiki — which is rare enough to accept, and far
 * cheaper than the alternative.
 */
const NON_PROSPECT_PATTERNS: RegExp[] = [
  // Education. .edu and .ac.* are decisive; the words are strong signals.
  /(^|\.)edu(\.[a-z]{2})?$/i,
  /(^|\.)ac\.[a-z]{2}$/i,
  /(^|\.|-)(academy|acad|school|schule|institute|university|college|campus|bootcamp)(\.|-|$)/i,
  // Learning and tutorials.
  /(^|\.|-)(courses?|tutorials?|learn|training|masterclass)(\.|-|$)/i,
  // Community and discussion.
  /(^|\.|-)(forums?|community|wiki|discuss|board)(\.|-|$)/i,
  // Publishing about the industry rather than working in it.
  /(^|\.|-)(magazine|news|blog|press|podcast)(\.|-|$)/i,
  // Hiring marketplaces and job boards: the artists there are reachable
  // through the platform, not at a site they own.
  /(^|\.|-)(jobs?|careers?|hiring|recruit)(\.|-|$)/i,
];

/**
 * Non-prospects that are still worth reading.
 *
 * A forum thread, a community showcase, a school's alumni page or a
 * "best artists of 2026" listicle is never someone to email — but it is full
 * of links to the people who are. Dropping those results throws away the best
 * source of personal sites in the whole pipeline, so they get mined for
 * outbound links instead of discarded.
 *
 * Marketplaces and tooling vendors are deliberately absent: their pages link
 * to profiles on their own domain, not to sites anyone owns.
 */
const MINEABLE_SOURCE_PATTERNS: RegExp[] = [
  /(^|\.|-)(forums?|community|discuss|board|wiki)(\.|-|$)/i,
  /(^|\.|-)(magazine|news|blog|press)(\.|-|$)/i,
  /(^|\.|-)(academy|school|institute|university|college|campus)(\.|-|$)/i,
  /(^|\.)edu(\.[a-z]{2})?$/i,
  /(^|\.)ac\.[a-z]{2}$/i,
];

const MINEABLE_HOSTS = [
  "blenderartists.org", "polycount.com", "cgsociety.org", "therookies.co",
  "80.lv", "cgchannel.com", "gamedeveloper.com", "reddit.com", "vanarts.com",
];

/**
 * Is this host worth opening for the links it carries, even though nobody
 * there is a prospect?
 */
export function isMineableSource(host: string): boolean {
  const h = normalizeHost(host);
  if (!h || !h.includes(".")) return false;
  const apex = h.split(".").slice(-2).join(".");
  if (MINEABLE_HOSTS.some((n) => h === n || apex === n || h.endsWith(`.${n}`))) return true;
  return MINEABLE_SOURCE_PATTERNS.some((re) => re.test(h));
}

/** File extensions that mean the link is an asset, not a business. */
const ASSET_RE = /\.(pdf|jpe?g|png|gif|svg|webp|mp4|zip|css|js|xml|rss)$/i;

export function isNonProspectHost(host: string): boolean {
  const h = normalizeHost(host);
  if (!h || !h.includes(".")) return true;
  if (isThirdPartyHost(h)) return true;
  const apex = h.split(".").slice(-2).join(".");
  if (NON_PROSPECT_HOSTS.some((n) => h === n || apex === n || h.endsWith(`.${n}`))) return true;
  return NON_PROSPECT_PATTERNS.some((re) => re.test(h));
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

/**
 * Same-host links that look like an entry for one business rather than site
 * furniture.
 *
 * On a platform directory — an artist marketplace, an agency roster — the
 * listing page links to profiles on its own domain, and the business's real
 * website only appears on the profile. Those links are invisible to
 * `extractOutboundProspects`, which drops same-host hrefs as navigation, so
 * they are collected separately for the second hop.
 */
export function extractSameHostLinks(input: {
  html: string;
  sourceUrl: string;
  limit?: number;
}): string[] {
  const $ = cheerio.load(input.html);
  const sourceHost = normalizeHost(input.sourceUrl);
  const sourcePath = (() => {
    try {
      return new URL(input.sourceUrl).pathname;
    } catch {
      return "/";
    }
  })();
  const out = new Set<string>();

  $("a[href]").each((_, el) => {
    if (out.size >= (input.limit ?? 20)) return false;
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
    if (url.protocol !== "https:") return undefined;
    if (normalizeHost(url.hostname) !== sourceHost) return undefined;
    if (ASSET_RE.test(url.pathname)) return undefined;
    if (url.pathname === sourcePath || url.pathname === "/") return undefined;
    if (NON_DETAIL_PATH_RE.test(url.pathname)) return undefined;

    // Detail pages sit shallow: /username, /agency/acme. Anything deeper is
    // usually a sub-tab of a profile rather than another business.
    const depth = url.pathname.split("/").filter(Boolean).length;
    if (depth < 1 || depth > 2) return undefined;

    // Query strings on a directory are filters and paging, not new entries.
    out.add(`${url.origin}${url.pathname}`.replace(/\/$/, ""));
    return undefined;
  });

  return [...out];
}

/** Same-host paths that are navigation or account plumbing, never a business. */
const NON_DETAIL_PATH_RE =
  /^\/(search|login|signin|signup|register|about|contact|terms|privacy|pricing|blog|jobs|help|support|faq|settings|account|cart|checkout|categories|category|tags?|page|feed|rss|api)(\/|$)/i;

/** Cap on community pages opened per tick, since each is a full page load. */
const MAX_MINED_SOURCES = 5;

const SEED_UA = "CrawlProofOutreach/1.0 (+https://crawlproof.com)";

/** Statuses that mean "the server refused a bot", not "the page is missing". */
function looksBlocked(status: number): boolean {
  return status === 401 || status === 403 || status === 405 || status === 429 || status === 503;
}

async function fetchHtml(
  url: string,
): Promise<
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; error: string; status?: number; loginRequired?: boolean }
> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": SEED_UA },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const html = await res.text();
    // The redirect onto a login page is visible here even though the login
    // form itself may only exist after scripts run, so this catches the wall
    // without paying for a render.
    const wall = looksLikeLoginWall({ requestedUrl: url, finalUrl: res.url, html });
    if (wall.loginRequired) {
      return { ok: false, loginRequired: true, error: `the site requires a login — ${wall.reason}` };
    }
    return { ok: true, html, finalUrl: res.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
}

/**
 * Get a seed page's HTML, rendering it in Chromium when a plain fetch won't do.
 *
 * Fetch runs first because it is an order of magnitude cheaper and most
 * directories are still server-rendered. The browser is the fallback for the
 * two cases fetch cannot handle: the server refused us, or it returned a page
 * whose listings arrive over XHR — which from here looks identical to a
 * directory with nothing on it.
 */
async function loadSeedHtml(
  url: string,
  allowRender: boolean,
  credentials?: SeedCredentials | null,
  codeWaiter?: CodeWaiter | null,
): Promise<{ html: string; rendered: boolean } | { error: string; loginRequired?: boolean }> {
  const direct = await fetchHtml(url);
  // A login wall is settled unless we hold a credential — without one,
  // rendering it again only renders the login page.
  if (!direct.ok && direct.loginRequired && !credentials) {
    return { error: direct.error, loginRequired: true };
  }
  if (direct.ok) {
    const hasCandidates = extractOutboundProspects({ html: direct.html, sourceUrl: url, limit: 1 }).length > 0;
    if (hasCandidates || !allowRender) return { html: direct.html, rendered: false };
  } else if (!allowRender) {
    return { error: direct.error };
  }

  const { renderPage } = await import("./render");
  const rendered = await renderPage(url, { credentials, codeWaiter });
  if (rendered.ok) return { html: rendered.html, rendered: true };
  if (rendered.loginRequired) return { error: rendered.error, loginRequired: true };

  // Prefer the render error: when both fail it is the more specific of the
  // two, and it distinguishes a bot challenge from an ordinary failure.
  if (direct.ok) return { html: direct.html, rendered: false };
  return { error: rendered.error };
}

export async function discoverFromSeed(input: {
  seedUrl: string;
  limit?: number;
  /** Allow the Chromium fallback. On by default. */
  render?: boolean;
  /**
   * 1 follows only outbound links on the seed page. 2 additionally opens
   * same-host listing entries and takes the outbound link from each, which is
   * what platform directories need — their listings all live on their own
   * domain, so depth 1 finds nothing there.
   */
  depth?: 1 | 2;
  /** Cap on second-hop pages opened, since each is a full page load. */
  maxDetailPages?: number;
  /** Sign-in for a gated directory, when one is stored for this host. */
  credentials?: SeedCredentials | null;
  /** Lets a user answer a verification code raised during that sign-in. */
  codeWaiter?: CodeWaiter | null;
  /**
   * Only take the second hop when the first found fewer than this many
   * businesses. Keeps ordinary directories at one cheap page load.
   */
  detailHopThreshold?: number;
}): Promise<{
  prospects: DiscoveredProspect[];
  error?: string;
  notes?: string[];
  /** Set when the seed was withheld pending a login, so the UI can offer to store one. */
  loginRequired?: boolean;
}> {
  const limit = input.limit ?? 100;
  const allowRender = input.render !== false;
  const notes: string[] = [];

  const seed = await loadSeedHtml(input.seedUrl, allowRender, input.credentials, input.codeWaiter);
  if ("error" in seed) {
    return {
      prospects: [],
      error: `seed ${input.seedUrl} failed: ${seed.error}`,
      loginRequired: seed.loginRequired,
    };
  }
  if (seed.rendered) notes.push(`rendered ${input.seedUrl} in a browser`);

  const merged = new Map<string, DiscoveredProspect>();
  for (const p of extractOutboundProspects({ html: seed.html, sourceUrl: input.seedUrl, limit })) {
    if (!merged.has(p.host)) merged.set(p.host, p);
  }

  // The second hop is expensive — one page load per listing, each possibly a
  // browser render — so it only runs when the first hop came up short. A
  // listicle that already yielded a page of businesses has nothing to gain
  // from opening its own internal links; a platform directory yields nothing
  // at all on the first hop, which is exactly the signal to go deeper.
  const firstHopThin = merged.size < (input.detailHopThreshold ?? 3);
  if ((input.depth ?? 1) >= 2 && firstHopThin && merged.size < limit) {
    const detailPages = extractSameHostLinks({
      html: seed.html,
      sourceUrl: input.seedUrl,
      limit: input.maxDetailPages ?? 12,
    });
    if (detailPages.length === 0) {
      notes.push("no listing entries found to open for a second hop");
    }
    for (const detailUrl of detailPages) {
      if (merged.size >= limit) break;
      const detail = await loadSeedHtml(detailUrl, allowRender, input.credentials, input.codeWaiter);
      if ("error" in detail) continue;
      for (const p of extractOutboundProspects({
        html: detail.html,
        sourceUrl: detailUrl,
        limit: limit - merged.size,
      })) {
        if (!merged.has(p.host)) merged.set(p.host, p);
      }
    }
    notes.push(`opened ${detailPages.length} listing entries`);
  }

  return { prospects: [...merged.values()], notes: notes.length ? notes : undefined };
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
  /** Org whose stored seed logins apply. Omitted means none are used. */
  organizationId?: string | null;
}): Promise<{
  prospects: DiscoveredProspect[];
  calls: number;
  error?: string;
  /** Result pages that are not prospects but link to people who are. */
  mineable: string[];
}> {
  const limit = Math.min(input.limit ?? 30, 100);
  const source = input.source ?? "auto";
  const out = new Map<string, DiscoveredProspect>();
  const mineable = new Set<string>();
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
      if (!host) continue;
      if (isNonProspectHost(host)) {
        // Not someone to contact, but a forum thread or alumni page is where
        // the personal sites actually are. Keep the exact result URL: the
        // thread is what carries the links, not the site's front page.
        if (isMineableSource(host) && r.url) mineable.add(r.url);
        continue;
      }
      if (out.has(host)) continue;
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
      if (isNonProspectHost(r.host)) {
        if (isMineableSource(r.host) && r.url) mineable.add(r.url);
        continue;
      }
      if (out.has(r.host)) continue;
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
    mineable: [...mineable],
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
  /** Org whose stored seed logins apply. Omitted means none are used. */
  organizationId?: string | null;
}): Promise<{
  prospects: DiscoveredProspect[];
  serpCalls: number;
  errors: string[];
  /** Seeds that returned a login wall — the UI offers to store credentials for these. */
  loginRequiredSeeds: string[];
}> {
  const limit = input.limit ?? 50;
  const merged = new Map<string, DiscoveredProspect>();
  const errors: string[] = [];
  const loginRequiredSeeds: string[] = [];
  const mineable = new Set<string>();
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
    for (const url of res.mineable) mineable.add(url);
    if (merged.size >= limit) break;
  }

  // Search results that were not prospects but link to people who are: forum
  // threads, alumni pages, "best artists of" listicles. Mining them is where
  // most personal sites come from, since an artist's own domain rarely
  // out-ranks the community discussing their work.
  //
  // Only worth the page loads when the funnel still has room, and capped so a
  // query that returns nothing but forums cannot spend the whole tick here.
  if (merged.size < limit) {
    for (const url of [...mineable].slice(0, MAX_MINED_SOURCES)) {
      if (merged.size >= limit) break;
      const res = await discoverFromSeed({ seedUrl: url, limit: limit - merged.size, depth: 1 });
      if (res.error) errors.push(res.error);
      for (const p of res.prospects) {
        if (!merged.has(p.host)) merged.set(p.host, { ...p, via: "seed", source: `mined:${url}` });
      }
    }
  }

  for (const seedUrl of (input.seedUrls ?? []).slice(0, 10)) {
    if (merged.size >= limit) break;
    // Depth 2 by default: a platform directory keeps every listing on its own
    // domain, so depth 1 silently returns nothing for exactly the pages users
    // most often paste in.
    const credentials = input.organizationId
      ? await loadSeedCredential(input.organizationId, seedHost(seedUrl))
      : null;
    const res = await discoverFromSeed({
      seedUrl,
      limit,
      depth: 2,
      credentials,
      // Only offer the code path when a credential exists to sign in with.
      codeWaiter: credentials ? makeSeedCodeWaiter(credentials.id) : null,
    });
    if (res.error) errors.push(res.error);
    // Only "waiting on the user" when we have nothing to try. A stored
    // credential that failed is a different problem and reads as an error.
    if (res.loginRequired && !credentials) loginRequiredSeeds.push(seedUrl);
    if (input.organizationId && credentials) {
      await recordSeedCredentialResult({
        organizationId: input.organizationId,
        host: seedHost(seedUrl),
        ok: !res.loginRequired,
        error: res.error,
      });
    }
    for (const p of res.prospects) if (!merged.has(p.host)) merged.set(p.host, p);
  }

  return { prospects: [...merged.values()].slice(0, limit), serpCalls, errors, loginRequiredSeeds };
}
