// Step two of contact discovery: look the business up when its own site
// doesn't publish an address.
//
// Crawling a site's own pages finds an address most of the time, but plenty
// of portfolios put contact behind a form, an image, or nothing at all — and
// a prospect with no address is a prospect that never gets contacted, however
// good a fit it was.
//
// So when the site itself yields nothing, search for it. Two shapes, in
// order: a site-scoped query, which surfaces contact pages the crawl missed
// because nothing linked to them; then an open query on the name, which finds
// the person where they publish elsewhere.
//
// Deliberately gated. This spends a SERP call per prospect, and only runs
// after the free path has already failed.

import { searchSerp } from "@/lib/alerts/valueserp";
import { discoverContactEmails, normalizeHost, type ContactCandidate } from "./cold";

const MAX_PAGES_TO_OPEN = 3;
const FETCH_TIMEOUT_MS = 8_000;

/** Emails visible in a SERP title or snippet, without opening anything. */
function emailsInText(text: string, host: string): ContactCandidate[] {
  // discoverContactEmails understands obfuscation and same-domain ranking;
  // wrapping the snippet in minimal markup lets it do that work here too.
  return discoverContactEmails(`<div>${text}</div>`, host);
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "CrawlProofOutreach/1.0 (+https://crawlproof.com)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export type FallbackResult = {
  candidates: ContactCandidate[];
  /** SERP calls spent, so the caller can report the cost honestly. */
  calls: number;
  note: string;
};

/**
 * Find a contact address for `host` using search, after crawling it failed.
 *
 * `label` is whatever the discovery step knew the business as — a person's
 * name, a studio name — which is what makes the second query work at all. A
 * host on its own is a poor search term.
 */
export async function findContactViaSearch(input: {
  host: string;
  label?: string | null;
}): Promise<FallbackResult> {
  const host = normalizeHost(input.host);
  if (!host) return { candidates: [], calls: 0, note: "no host" };

  const found = new Map<string, ContactCandidate>();
  let calls = 0;
  const add = (list: ContactCandidate[]) => {
    for (const c of list) if (!found.has(c.email)) found.set(c.email, c);
  };

  // Query 1: the site's own contact pages, including ones nothing links to.
  const scoped = await searchSerp({ query: `site:${host} (contact OR email OR about)`, recency: "any", num: 10 });
  calls += scoped.calls;

  const pagesToOpen: string[] = [];
  for (const r of scoped.results) {
    add(emailsInText(`${r.title} ${r.snippet}`, host));
    if (normalizeHost(r.domain) === host) pagesToOpen.push(r.url);
  }

  // Open the most likely contact pages. The crawl already tried the obvious
  // paths, so these are the ones it could not have guessed.
  for (const url of pagesToOpen.slice(0, MAX_PAGES_TO_OPEN)) {
    if ([...found.values()].some((c) => c.sameDomain)) break;
    const html = await fetchText(url);
    if (html) add(discoverContactEmails(html, host));
  }

  if ([...found.values()].some((c) => c.sameDomain)) {
    return {
      candidates: rank([...found.values()]),
      calls,
      note: `found via site-scoped search of ${host}`,
    };
  }

  // Query 2: the business by name, wherever it publishes. Only worth doing
  // when discovery actually knew a name — searching a bare hostname returns
  // the site we already crawled.
  const label = (input.label ?? "").trim();
  if (label && label.toLowerCase() !== host) {
    const open = await searchSerp({
      query: `"${label}" (email OR contact) -site:${host}`,
      recency: "any",
      num: 10,
    });
    calls += open.calls;
    for (const r of open.results) add(emailsInText(`${r.title} ${r.snippet}`, host));
  }

  const candidates = rank([...found.values()]);
  return {
    candidates,
    calls,
    note: candidates.length
      ? `found ${candidates.length} candidate address(es) via search`
      : "search found no contact address either",
  };
}

/**
 * Same-domain addresses first.
 *
 * An address on the business's own domain is far likelier to be theirs than
 * one scraped from a third-party page, where the snippet may belong to
 * somebody else entirely on a listing site.
 */
function rank(list: ContactCandidate[]): ContactCandidate[] {
  return [...list].sort((a, b) => Number(b.sameDomain) - Number(a.sameDomain));
}
