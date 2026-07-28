// Contact details that only exist inside a PDF.
//
// Companies put the address you actually want in a capability statement, a
// media kit or a data-sheet, and link to it from a page whose HTML says
// nothing. The crawler reads the HTML, finds no address, and moves on — while
// the answer sits one link away in a file it never opened.
//
// Bounded on purpose. A PDF is a slow, large fetch that yields at most a few
// addresses, so only documents linked from a page already being read are
// considered, only the first few, and only up to a size worth the wait.

import { extractText, getDocumentProxy } from "unpdf";
import { discoverContactEmails, normalizeHost, type ContactCandidate } from "./cold";

const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_PDF_PAGES = 25;
const FETCH_TIMEOUT_MS = 20_000;

/** Filenames that suggest a document naming humans, best first. */
const PROMISING_NAME =
  /(capabilit|contact|team|leadership|about|company|profile|brochure|media[-_ ]?kit|overview|prospectus|annual|fact[-_ ]?sheet)/i;

/**
 * PDFs worth opening, most promising first.
 *
 * Every PDF on a site is not worth a twelve-megabyte download; a "capability
 * statement" is, and a terms-and-conditions is not. Ordering by filename is
 * a weak signal but it is free, and it decides which few get opened.
 */
export function pdfLinksFrom(html: string, sourceUrl: string, limit = 3): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)) {
    try {
      const url = new URL(m[1], sourceUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      out.add(url.toString());
    } catch {
      // Unparseable href.
    }
  }
  return [...out]
    .sort((a, b) => Number(PROMISING_NAME.test(b)) - Number(PROMISING_NAME.test(a)))
    .slice(0, limit);
}

/** Text of a PDF, or null. Never throws — a bad document is not an error. */
export async function pdfText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "CrawlProofOutreach/1.0 (+https://crawlproof.com)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const type = res.headers.get("content-type") ?? "";
    // A .pdf href that serves HTML is a login wall or a 404 page dressed as
    // one; parsing it wastes the download and finds nothing.
    if (type && !/pdf|octet-stream/i.test(type)) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) return null;

    const doc = await getDocumentProxy(new Uint8Array(buf));
    // Page cap rather than whole-document: contact details live at the front
    // or the back, and a 400-page report costs far more to parse than the
    // address is worth.
    const { text } = await extractText(doc, { mergePages: true });
    return typeof text === "string" ? text.slice(0, 200_000) : null;
  } catch {
    return null;
  }
}

/**
 * Addresses found inside the documents a page links to.
 *
 * `discoverContactEmails` expects markup, so the extracted text is wrapped
 * before being handed over — that keeps one implementation of what counts as
 * an address, including the obfuscation handling, rather than a second one
 * that drifts.
 */
export async function contactsFromDocuments(input: {
  html: string;
  sourceUrl: string;
  host: string;
  limit?: number;
}): Promise<{ candidates: ContactCandidate[]; opened: string[] }> {
  const host = normalizeHost(input.host);
  const links = pdfLinksFrom(input.html, input.sourceUrl, input.limit ?? 3);
  const found = new Map<string, ContactCandidate>();
  const opened: string[] = [];

  for (const link of links) {
    const text = await pdfText(link);
    if (!text) continue;
    opened.push(link);
    for (const c of discoverContactEmails(`<div>${text}</div>`, host)) {
      if (!found.has(c.email)) found.set(c.email, c);
    }
    // One document with a same-domain address is enough; the rest are
    // downloads that cannot improve on it.
    if ([...found.values()].some((c) => c.sameDomain)) break;
  }

  return { candidates: [...found.values()], opened };
}

/** Paths that name the people at a company rather than describing it. */
const TEAM_PATH_RE =
  /\/(team|our-team|people|our-people|leadership|management|staff|founders|executives|who-we-are|meet-the-team|board)(\/|$|\.html?$)/i;

/**
 * Same-host pages that list the people at a company.
 *
 * A named person's address outperforms info@ by enough to be worth one extra
 * fetch, and a team page is where those names and addresses are published.
 */
export function teamPageLinks(html: string, sourceUrl: string, limit = 2): string[] {
  const out = new Set<string>();
  let sourceHost = "";
  try {
    sourceHost = normalizeHost(new URL(sourceUrl).hostname);
  } catch {
    return [];
  }

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(m[1], sourceUrl);
      if (normalizeHost(url.hostname) !== sourceHost) continue;
      if (!TEAM_PATH_RE.test(url.pathname)) continue;
      out.add(`${url.origin}${url.pathname}`.replace(/\/$/, ""));
    } catch {
      // Unparseable href.
    }
  }
  return [...out].slice(0, limit);
}
