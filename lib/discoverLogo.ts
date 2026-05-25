import * as cheerio from "cheerio";

// Walk a page's <head> and pick the best-looking logo URL. Returns
// null if we can't find anything plausible (offline, parse error,
// site explicitly has no icons).
//
// Preference order — this is what the dashboard ends up showing:
//   1. apple-touch-icon (largest size attribute wins)
//   2. <link rel="icon"> with type=image/svg+xml
//   3. <link rel="icon"> with the largest size attribute
//   4. og:image (good for sites that don't ship a proper favicon set)
//   5. twitter:image
//   6. /favicon.ico — last-ditch, almost every site has this
//
// We trust HTTP redirects on the page fetch (so http://foo -> https://foo
// works) but cap response time at FETCH_TIMEOUT_MS so a slow site can't
// block a project create or dashboard render.

const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 1_000_000; // 1 MB of HTML is way more than enough for <head>

export async function discoverLogoUrl(siteUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const html = await fetchHead(siteUrl);
  if (!html) {
    // Even without the HTML, /favicon.ico is a defensible guess.
    return `${parsed.origin}/favicon.ico`;
  }

  const $ = cheerio.load(html);

  const candidates: { url: string; weight: number }[] = [];

  $('link[rel*="apple-touch-icon" i]').each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const size = parseSizes($(el).attr("sizes"));
    // Apple icons are usually the prettiest variant; rank by size.
    candidates.push({ url: href, weight: 1000 + size });
  });

  $('link[rel*="icon" i]').each((_i, el) => {
    const $el = $(el);
    const rel = ($el.attr("rel") ?? "").toLowerCase();
    if (rel.includes("apple-touch-icon")) return; // already collected above
    const href = $el.attr("href");
    if (!href) return;
    const type = ($el.attr("type") ?? "").toLowerCase();
    const size = parseSizes($el.attr("sizes"));
    // SVG icons scale to any DOM size — prefer them over raster.
    const base = type === "image/svg+xml" ? 800 : 400;
    candidates.push({ url: href, weight: base + size });
  });

  const og = $('meta[property="og:image"]').attr("content");
  if (og) candidates.push({ url: og, weight: 200 });
  const tw = $('meta[name="twitter:image"]').attr("content");
  if (tw) candidates.push({ url: tw, weight: 150 });

  candidates.push({ url: "/favicon.ico", weight: 1 });

  candidates.sort((a, b) => b.weight - a.weight);

  for (const c of candidates) {
    const abs = absolutize(c.url, parsed);
    if (abs) return abs;
  }
  return null;
}

function parseSizes(attr: string | undefined): number {
  if (!attr) return 0;
  // sizes="180x180" or sizes="32x32 16x16" — pick the largest dimension.
  let max = 0;
  for (const tok of attr.split(/\s+/)) {
    const m = tok.match(/^(\d+)x(\d+)$/i);
    if (m) {
      const n = Math.max(parseInt(m[1], 10), parseInt(m[2], 10));
      if (n > max) max = n;
    }
  }
  return max;
}

function absolutize(href: string, base: URL): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function fetchHead(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        // Some sites serve a barebones page to default user-agents and
        // gate the real <head> behind a "real browser" check; mimic one.
        "User-Agent":
          "Mozilla/5.0 (compatible; CrawlProofLogoBot/1.0; +https://crawlproof.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("text/html")) return null;

    // Stream and cap so a 50 MB HTML page can't blow up the worker.
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const decoder = new TextDecoder();
    let buf = "";
    let read = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        read += value.byteLength;
        buf += decoder.decode(value, { stream: true });
        // We only care about <head>; bail once we've passed </head>
        // or hit the byte cap.
        if (read >= MAX_BYTES || /<\/head\s*>/i.test(buf)) break;
      }
    }
    try {
      reader.cancel();
    } catch {
      // ignore — body might already be closed
    }
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
