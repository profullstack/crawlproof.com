// Backlink confirmation: SERP surfaces a candidate page that mentions the
// user's domain; we crawl it and only alert if the HTML actually contains an
// anchor linking to that domain. A plain-text mention with no link does not
// qualify (PRD §7 AC). JS-injected links are common, so if the static HTML
// has no anchor we fall back to the rendered DOM before concluding "no link".

import * as cheerio from "cheerio";
import { fetchPage } from "@/lib/audit/fetch";
import { attachRendered } from "@/lib/audit/render";
import { hostMatchesDomain } from "./dedupe";

export type BacklinkCheck = {
  // A real anchor to the target domain was found.
  confirmed: boolean;
  // The fetch failed (network/timeout/non-2xx). Distinct from "fetched but no
  // link" so the engine can retry once before dropping — never falsely
  // reporting a fetch failure as a backlink.
  fetchError: boolean;
};

export function htmlHasLinkTo(html: string, domain: string): boolean {
  if (!html) return false;
  const $ = cheerio.load(html);
  let found = false;
  $("a[href]").each((_, el) => {
    if (found) return;
    const href = $(el).attr("href") ?? "";
    let host = "";
    try {
      host = new URL(href, "https://example.invalid").hostname;
    } catch {
      return;
    }
    // Skip relative hrefs that resolved onto the placeholder base.
    if (host === "example.invalid") return;
    if (hostMatchesDomain(host, domain)) found = true;
  });
  return found;
}

/** Confirm (once, no internal retry) whether `pageUrl` links to `domain`. */
export async function confirmBacklink(pageUrl: string, domain: string): Promise<BacklinkCheck> {
  const page = await fetchPage(pageUrl);
  if (page.status === 0 || page.error) {
    return { confirmed: false, fetchError: true };
  }
  if (htmlHasLinkTo(page.rawHtml, domain)) {
    return { confirmed: true, fetchError: false };
  }
  // Static HTML had no matching anchor — try the JS-rendered DOM before
  // concluding there's no link.
  try {
    const rendered = await attachRendered(page);
    if (rendered.renderedHtml && htmlHasLinkTo(rendered.renderedHtml, domain)) {
      return { confirmed: true, fetchError: false };
    }
  } catch {
    // Render failures don't count as a fetch error for retry purposes — we
    // already have static HTML that simply didn't contain the link.
  }
  return { confirmed: false, fetchError: false };
}
