import * as cheerio from "cheerio";

// Walk a page's <head> (and its web-app manifest) and pick the best logo URL
// that ACTUALLY RESOLVES to an image. Returns null if nothing plausible loads
// (offline, parse error, site has no usable icons) — the dashboard then shows a
// letter avatar instead of a broken <img>.
//
// Preference order:
//   1. web-app-manifest icons (largest; often the real brand logo)
//   2. apple-touch-icon (largest size wins)
//   3. <link rel="icon"> svg, then largest raster; mask-icon
//   4. og:image / twitter:image (sites with no proper favicon set)
//   5. /favicon.ico — last-ditch
//
// Every candidate is verified with a real request (2xx + image content-type)
// before we accept it, so we never persist a 404'ing URL. We trust redirects
// on the page fetch but cap response time so a slow site can't block a project
// create or dashboard render.

const FETCH_TIMEOUT_MS = 4000;
const VALIDATE_TIMEOUT_MS = 3000;
const MAX_BYTES = 1_000_000; // 1 MB of HTML is way more than enough for <head>
const MAX_VALIDATIONS = 6; // cap image HEAD/GET checks so we stay snappy

const UA =
  "Mozilla/5.0 (compatible; CrawlProofLogoBot/1.0; +https://crawlproof.com)";

const IMAGE_EXT_RE = /\.(png|jpe?g|svg|ico|webp|gif|avif)(\?|#|$)/i;

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
    // Even without the HTML, /favicon.ico is a defensible guess — if it loads.
    const ico = `${parsed.origin}/favicon.ico`;
    return (await isImageUrl(ico)) ? ico : null;
  }

  const $ = cheerio.load(html);
  // Respect <base href> for resolving relative icon URLs.
  const baseHref = $("base[href]").attr("href");
  const base = baseHref ? safeUrl(baseHref, parsed) ?? parsed : parsed;

  const candidates: { url: string; weight: number }[] = [];
  const add = (href: string | undefined, weight: number) => {
    if (!href) return;
    const abs = absolutize(href, base);
    if (abs) candidates.push({ url: abs, weight });
  };

  $('link[rel*="apple-touch-icon" i]').each((_i, el) => {
    add($(el).attr("href"), 900 + parseSizes($(el).attr("sizes")));
  });

  $('link[rel*="icon" i]').each((_i, el) => {
    const $el = $(el);
    const rel = ($el.attr("rel") ?? "").toLowerCase();
    if (rel.includes("apple-touch-icon")) return; // collected above
    const type = ($el.attr("type") ?? "").toLowerCase();
    const size = parseSizes($el.attr("sizes"));
    // SVG icons scale to any DOM size — prefer them over raster.
    const weight = type === "image/svg+xml" ? 800 + size : 400 + size;
    add($el.attr("href"), weight);
  });

  // Safari pinned-tab / mask icon — usually a clean monochrome SVG logo.
  $('link[rel*="mask-icon" i]').each((_i, el) => {
    add($(el).attr("href"), 700);
  });

  add($('meta[property="og:image"]').attr("content"), 200);
  add($('meta[name="twitter:image"]').attr("content"), 150);

  // Web app manifest icons — often the highest-quality brand mark.
  const manifestHref = $('link[rel="manifest" i]').attr("href");
  if (manifestHref) {
    const manifestUrl = absolutize(manifestHref, base);
    if (manifestUrl) {
      for (const icon of await fetchManifestIcons(manifestUrl)) {
        // Rank just below apple-touch so a big manifest icon can win.
        add(icon.src, 950 + icon.size);
      }
    }
  }

  add(`${parsed.origin}/favicon.ico`, 1);

  // Highest weight first, de-duped, then return the first that actually loads.
  const seen = new Set<string>();
  const ordered = candidates
    .sort((a, b) => b.weight - a.weight)
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));

  let checked = 0;
  for (const c of ordered) {
    if (checked >= MAX_VALIDATIONS) break;
    checked++;
    if (await isImageUrl(c.url)) return c.url;
  }
  return null;
}

// Resolve a manifest URL to its icon list ({src, size}), largest first-ish.
async function fetchManifestIcons(
  manifestUrl: string,
): Promise<{ src: string; size: number }[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(manifestUrl, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "application/manifest+json,application/json" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      icons?: Array<{ src?: string; sizes?: string }>;
    };
    const manifestBase = new URL(manifestUrl);
    const out: { src: string; size: number }[] = [];
    for (const icon of json.icons ?? []) {
      const abs = icon.src ? safeUrl(icon.src, manifestBase) : null;
      if (abs) out.push({ src: abs.toString(), size: parseSizes(icon.sizes) });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Verify a URL responds 2xx with an image content-type (or an image extension
// when a server sends a generic type). Cancels the body so we don't download
// the whole image.
async function isImageUrl(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "image/*,*/*" },
    });
    void res.body?.cancel().catch(() => {});
    if (!res.ok) return false;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.startsWith("image/")) return true;
    // Some CDNs mislabel; trust a clear image extension on a 2xx.
    return IMAGE_EXT_RE.test(new URL(res.url || url).pathname);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function parseSizes(attr: string | undefined): number {
  if (!attr) return 0;
  if (/any/i.test(attr)) return 512; // scalable ("any") — treat as large
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

function safeUrl(href: string, base: URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function absolutize(href: string, base: URL): string | null {
  return safeUrl(href, base)?.toString() ?? null;
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
