// Stepping through a paginated directory.
//
// A listing page shows a fraction of what it holds — the run that prompted
// this saw sixteen of a directory's entries and reported that as the whole
// thing, which is indistinguishable from a short directory. Paging is what
// turns one page of a source into the source.
//
// Finding the next page by URL is deliberately tried before anything else.
// A resolvable href works on the fetch-first path, so an ordinary paginated
// directory costs one cheap request per page instead of one browser render
// per page. Clicking is the fallback for listings whose control carries no
// href at all, and it is the expensive one.

// Visible text is matched whole: a link reading "next" is a pagination
// control, whereas one reading "next steps" is prose that happens to start
// with the word.
const NEXT_TEXT_RE = /^\s*(next|older|more|load more|show more|»|›|→|>>?)\s*$/i;

// An aria-label is written to be read aloud — "Next page", "Go to next
// results" — so it is matched on the word rather than the whole string.
// Labels are short and purposeful, which makes this safe here and unsafe
// for link text.
const NEXT_LABEL_RE = /\bnext\b|\bload more\b|\bshow more\b/i;

/** Params a site uses to mean "which page". */
const PAGE_PARAMS = ["page", "p", "pg", "offset", "start", "from"];

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The URL of the next listing page, or null.
 *
 * Ordered by how much the page is actually asserting. `rel="next"` is the
 * site stating it outright; link text is a convention; incrementing a page
 * parameter is a guess, and a guess that can loop, so it is last and only
 * taken when the current URL already carries such a parameter — inventing
 * `?page=2` on a URL that never had one invents a page that may not exist.
 */
export function findNextPageUrl(html: string, currentUrl: string): string | null {
  // 1. <link rel="next"> / <a rel="next">
  const relNext =
    html.match(/<(?:link|a)[^>]+rel=["'][^"']*\bnext\b[^"']*["'][^>]*href=["']([^"']+)["']/i) ??
    html.match(/<(?:link|a)[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*\bnext\b[^"']*["']/i);
  if (relNext?.[1]) {
    const url = absolute(relNext[1], currentUrl);
    if (url && url !== currentUrl) return url;
  }

  // 2. An anchor whose visible text is a next-page control. aria-label is
  //    checked too, because the arrow is often an icon with no text node.
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,80}?)<\/a>/gi)) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").trim();
    const aria = attrs.match(/aria-label=["']([^"']+)["']/i)?.[1] ?? "";
    if (!NEXT_TEXT_RE.test(text) && !NEXT_LABEL_RE.test(aria)) continue;
    // A disabled control is on the last page and must not be followed.
    if (/\baria-disabled=["']true["']|\bdisabled\b/i.test(attrs)) continue;
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || href.startsWith("#")) continue;
    const url = absolute(href, currentUrl);
    if (url && url !== currentUrl) return url;
  }

  // 3. Increment an existing page parameter. Only when one is already
  //    present — otherwise this fabricates a second page for every site.
  try {
    const url = new URL(currentUrl);
    for (const param of PAGE_PARAMS) {
      const raw = url.searchParams.get(param);
      if (raw === null) continue;
      const n = Number(raw);
      if (!Number.isInteger(n)) continue;
      // offset/start count rows, not pages, and there is no way to know the
      // page size from here — so only page-numbered params are advanced.
      if (param === "offset" || param === "start" || param === "from") continue;
      url.searchParams.set(param, String(n + 1));
      return url.toString();
    }
  } catch {
    // Not a URL we can reason about.
  }

  return null;
}

/**
 * A CSS selector for a clickable next control that carries no usable href.
 *
 * Only worth reaching for once findNextPageUrl has failed, since clicking
 * requires a live browser for every page.
 */
export function nextClickSelector(html: string): string | null {
  const hasHrefless =
    /<button\b[^>]*>(\s*(next|more|load more|show more|»|›|→)\s*)<\/button>/i.test(html) ||
    /<(?:button|a)\b[^>]*aria-label=["'](next[^"']*)["']/i.test(html);
  if (!hasHrefless) return null;
  // Matched broadly on purpose: the caller verifies the element is visible
  // and enabled before clicking, so a selector that over-matches is cheap
  // while a selector that under-matches loses the rest of the directory.
  return [
    'button:has-text("Next")',
    'button:has-text("Load more")',
    'button:has-text("Show more")',
    '[aria-label*="Next" i]',
  ].join(", ");
}
