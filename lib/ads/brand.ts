import { discoverLogoUrl } from "@/lib/discoverLogo";
import { smartFetch } from "@/lib/onion";

// Extract a site's brand signals for ad-creative generation: title, meta
// description, logo, and a candidate colour palette. Deliberately lightweight —
// one capped HTML fetch here plus discoverLogoUrl's own fetch. This feeds the
// LLM copy/colour pass in lib/ads/creative.ts.

const UA = "Mozilla/5.0 (compatible; CrawlProofAdBot/1.0; +https://crawlproof.com)";
const TIMEOUT_MS = 8000;
const MAX_BYTES = 300_000;
const MAX_TEXT_CHARS = 6000;

export type SiteBrand = {
  url: string;
  domain: string;
  title: string;
  description: string;
  text: string; // reduced page text for the LLM
  logoUrl: string | null;
  themeColor: string | null;
  palette: string[]; // up to ~6 candidate hex colours, most common first
};

export function normalizeUrl(raw: string): string {
  const u = (raw ?? "").trim();
  if (!u) return u;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function metaContent(html: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  }
  return "";
}

function reduceText(html: string): string {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(body).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

// Frequency-rank hex colours that appear in inline styles / CSS, dropping the
// near-black/near-white extremes that every page has so the accent survives.
function extractPalette(html: string): string[] {
  const counts = new Map<string, number>();
  const re = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.replace(/(.)/g, "$1$1");
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const scored = [...counts.entries()]
    .filter(([hex]) => {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum > 18 && lum < 237; // drop pure black/white-ish
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hex]) => `#${hex}`);
  return scored;
}

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await smartFetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return "";
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("text/html")) return "";
    const reader = res.body?.getReader();
    if (!reader) return (await res.text()).slice(0, MAX_BYTES);
    const decoder = new TextDecoder();
    let buf = "";
    let read = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        read += value.byteLength;
        buf += decoder.decode(value, { stream: true });
        if (read >= MAX_BYTES) break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // body may already be closed
    }
    return buf;
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function extractSiteBrand(rawUrl: string): Promise<SiteBrand> {
  const url = normalizeUrl(rawUrl);
  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // leave domain as-is
  }

  const [html, logoUrl] = await Promise.all([
    fetchHtml(url),
    discoverLogoUrl(url).catch(() => null),
  ]);

  const title = metaContent(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ]);
  const description = metaContent(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
  ]);
  const themeColor =
    metaContent(html, [
      /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']*)["']/i,
    ]) || null;

  return {
    url,
    domain,
    title: title || domain,
    description,
    text: reduceText(html),
    logoUrl,
    themeColor,
    palette: extractPalette(html),
  };
}
