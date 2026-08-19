// Work out whether a publisher's site is light or dark, from its markup.
//
// Used to give every ad slot a sensible default polarity without asking the
// publisher anything. The /ad.js tag measures the real page at fill time and
// its answer always wins; this is the fallback for surfaces that cannot
// measure — a MOTD over curl, a feed spliced at build time, a page whose
// script was blocked — and the seed the backfill writes onto existing slots.
//
// Deliberately no browser. One capped HTML fetch plus at most a couple of
// stylesheets, and a set of ordered signals. It is allowed to be unsure:
// `null` means "we could not tell", which the caller stores as 'auto'.

import { smartFetch } from "@/lib/onion";
import { luminance, parseColor, type AdTheme } from "./theme";

const UA = "Mozilla/5.0 (compatible; CrawlProofAdBot/1.0; +https://crawlproof.com)";
const TIMEOUT_MS = 8000;
const MAX_BYTES = 300_000;
/** Stylesheets are only worth reading until we find a body/html background. */
const MAX_STYLESHEETS = 3;

export type SiteThemeVerdict = {
  theme: AdTheme | null;
  /** Which signal decided it — carried into the backfill's log. */
  reason: string;
};

async function fetchText(url: string, accept: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await smartFetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: accept },
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, MAX_BYTES);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Strip comments so a commented-out rule cannot decide a site's polarity. */
function decomment(css: string): string {
  return stripPreferenceMedia(css.replace(/\/\*[\s\S]*?\*\//g, ""));
}

/**
 * Remove `@media (prefers-color-scheme: …)` blocks.
 *
 * These describe what a *particular visitor* sees, not what the site is. A
 * stylesheet that defines `--bg: #fbfaf8` on :root and overrides it to near
 * black inside a dark-preference block is a light site with a dark mode, and
 * counting the override as "last declaration wins" flips the verdict for every
 * such site. What an individual visitor actually has is measured by the tag at
 * fill time, which is the only place that question can honestly be answered.
 *
 * Brace-balanced rather than regex-matched, because these blocks nest rules.
 */
function stripPreferenceMedia(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) {
      out += css.slice(i);
      break;
    }
    const open = css.indexOf("{", at);
    if (open === -1) {
      out += css.slice(i);
      break;
    }
    const prelude = css.slice(at, open);
    if (!/prefers-color-scheme/i.test(prelude)) {
      out += css.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    // Walk to the matching close brace and drop the whole block.
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    out += css.slice(i, at);
    i = j;
  }
  return out;
}

/**
 * The background declared for the page itself.
 *
 * Only `html`, `:root` and `body` rules count. A background on some card
 * component says nothing about the page the ad will sit on, and matching them
 * is how a naive scan concludes that a white site is dark.
 */
/**
 * Custom properties declared on the page-level selectors.
 *
 * Modern stylesheets almost never write a literal colour on `body`. They write
 * `body { background: var(--bg) }` and define `--bg` on `:root`. Without this
 * the scan finds no background at all and falls through to the light default,
 * which is silently wrong for every dark variable-driven site.
 */
function customProperties(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!isPageSelector(m[1])) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      vars.set(d[1].trim(), d[2].trim());
    }
  }
  return vars;
}

/** Resolve var(--x, fallback) against the collected properties. Bounded. */
function resolveVars(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 4 || !value.includes("var(")) return value;
  const next = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
    return vars.get(name) ?? (fallback ?? "").trim();
  });
  return next === value ? next : resolveVars(next, vars, depth + 1);
}

function isPageSelector(raw: string): boolean {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((s) => s === "html" || s === "body" || s === ":root" || s === "html body" || s === "*,body");
}

function pageBackground(css: string): string | null {
  const text = decomment(css);
  const vars = customProperties(text);
  // Last declaration wins in CSS, so walk matches in order and keep the last.
  let found: string | null = null;
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of text.matchAll(ruleRe)) {
    if (!isPageSelector(m[1])) continue;
    const decl = m[2];
    // `background-color:` outright, or the colour term of a `background:`
    // shorthand. Anything that is not a parseable colour is skipped.
    // `background-color` is a plain colour; the `background` shorthand may be
    // layered, and only its final layer can carry the colour.
    const flat = /background-color\s*:\s*([^;]+)/i.exec(decl)?.[1];
    const shorthand = /background\s*:\s*([^;]+)/i.exec(decl)?.[1];
    const color = flat
      ? colorTerm(resolveVars(flat, vars))
      : shorthand
        ? backgroundColorOf(resolveVars(shorthand, vars))
        : null;
    if (color) found = color;
  }
  return found;
}

const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "",
};

/**
 * Split a `background` shorthand into its layers, on top-level commas only.
 *
 * Commas inside `rgb()`, `radial-gradient()` or `color-mix()` are not layer
 * separators. Getting this wrong is how a page whose background is
 * `radial-gradient(... var(--accent) ...), var(--bg)` gets read as its *accent*
 * colour: the accent appears first in the string, but it is a decorative wash
 * over the base layer, which is the one a reader actually sees behind text.
 */
function backgroundLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      layers.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) layers.push(current);
  return layers;
}

/**
 * The colour of a `background` shorthand.
 *
 * CSS only permits a background-color on the FINAL layer, so that is the one
 * consulted. Earlier layers are images and gradients painted on top of it.
 */
function backgroundColorOf(value: string): string | null {
  const layers = backgroundLayers(value);
  if (layers.length === 0) return null;
  const base = layers[layers.length - 1];
  const color = colorTerm(base);
  if (color) return color;
  // A single-layer value that is purely a gradient has no background colour;
  // reading a stop out of it would be a guess, so we decline to answer.
  return null;
}

/** First parseable colour in a CSS value, as a hex. */
function colorTerm(value: string): string | null {
  const v = value.trim().toLowerCase();
  const hex = /#[0-9a-f]{3,8}\b/.exec(v)?.[0];
  if (hex && parseColor(hex)) return hex;
  const rgb = /rgba?\(([^)]+)\)/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      const two = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
      return `#${two(parts[0])}${two(parts[1])}${two(parts[2])}`;
    }
  }
  for (const [name, value2] of Object.entries(NAMED)) {
    if (new RegExp(`\\b${name}\\b`).test(v)) return value2 || null;
  }
  return null;
}

function themeFrom(color: string): AdTheme {
  return luminance(color) >= 0.5 ? "light" : "dark";
}

/**
 * Decide a site's polarity from its homepage.
 *
 * Signal order, strongest first:
 *   1. a background declared for html/body/:root, inline or in a stylesheet
 *   2. `color-scheme: dark` with no light counterpart
 *   3. `<meta name="color-scheme">`
 *   4. nothing at all → light, because a page with no background of its own is
 *      painted white by every browser. This is the case that started the whole
 *      feature: a plain black-on-white blog with no CSS.
 *
 * `<meta name="theme-color">` is deliberately NOT used. It sets the mobile
 * browser chrome and is routinely a dark brand colour on a white site, which
 * is exactly backwards for this decision.
 */
export async function detectSiteTheme(rawUrl: string): Promise<SiteThemeVerdict> {
  const url = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const html = await fetchText(url, "text/html,application/xhtml+xml");
  if (!html) return { theme: null, reason: "unreachable" };

  // Inline <style> blocks and the body's own style attribute.
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const bodyStyle = /<body[^>]*\sstyle\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? "";

  const bodyInlineBg = bodyStyle ? colorTerm(bodyStyle) : null;
  if (bodyInlineBg) return { theme: themeFrom(bodyInlineBg), reason: `body style ${bodyInlineBg}` };

  const inlineBg = pageBackground(inline);
  if (inlineBg) return { theme: themeFrom(inlineBg), reason: `inline css ${inlineBg}` };

  // Linked stylesheets, in document order, until one declares a page background.
  const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(m[0]))
    .map((m) => /href\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1])
    .filter((h): h is string => !!h)
    .slice(0, MAX_STYLESHEETS);

  for (const href of hrefs) {
    let sheetUrl: string;
    try {
      sheetUrl = new URL(href, url).toString();
    } catch {
      continue;
    }
    const css = await fetchText(sheetUrl, "text/css");
    if (!css) continue;
    const bg = pageBackground(css);
    if (bg) return { theme: themeFrom(bg), reason: `stylesheet ${bg}` };
    const scheme = colorScheme(css);
    if (scheme) return { theme: scheme, reason: `color-scheme (css)` };
  }

  const scheme = colorScheme(inline) ?? metaColorScheme(html);
  if (scheme) return { theme: scheme, reason: "color-scheme" };

  // Nothing declared anywhere. The browser paints its own canvas, which is
  // white — regardless of the visitor's OS preference.
  return { theme: "light", reason: "no declared background (browser default)" };
}

function colorScheme(css: string): AdTheme | null {
  const m = /color-scheme\s*:\s*([^;}]+)/i.exec(decomment(css));
  return schemeVerdict(m?.[1]);
}

function metaColorScheme(html: string): AdTheme | null {
  const m = /<meta[^>]+name\s*=\s*["']color-scheme["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html);
  return schemeVerdict(m?.[1]);
}

/**
 * `color-scheme: dark` alone means the page is dark. `light dark` means it
 * adapts, which tells us nothing about what any given visitor sees — so it is
 * not a verdict.
 */
function schemeVerdict(value: string | undefined): AdTheme | null {
  const v = (value ?? "").toLowerCase();
  if (!v) return null;
  const dark = /\bdark\b/.test(v);
  const light = /\blight\b/.test(v);
  if (dark && !light) return "dark";
  if (light && !dark) return "light";
  return null;
}
