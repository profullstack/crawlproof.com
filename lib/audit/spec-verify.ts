import * as cheerio from "cheerio";
import type { FetchedPage } from "./types";

/**
 * Machine checks for The Website Specification's required items, keyed by the last
 * path segment of each item's reference URL (spec/security/hsts/ → "hsts").
 *
 * The spec MCP server returns a checklist, not results. Without these checks every
 * item was reported as "needs verification" and every site scored the same 50. Each
 * check here looks only at what one fetch of the page (plus, for two of them, one
 * extra request) can prove; anything that needs a browser or a human (contrast,
 * keyboard traps, Core Web Vitals) has no entry and is listed as not verified.
 */
export type SpecVerdict = { status: "pass" | "warn" | "fail"; note: string };

export type SpecExtras = {
  /** Status of a request for a path that cannot exist, and whether it returned HTML. */
  notFound?: { status: number; html: boolean } | null;
  /** Status and Location of the plain-http version of the page. */
  httpRedirect?: { status: number; location: string | null } | null;
};

type Check = (page: FetchedPage, $: cheerio.CheerioAPI, extras: SpecExtras) => SpecVerdict;

const pass = (note: string): SpecVerdict => ({ status: "pass", note });
const warn = (note: string): SpecVerdict => ({ status: "warn", note });
const fail = (note: string): SpecVerdict => ({ status: "fail", note });

const header = (page: FetchedPage, name: string) => page.headers[name.toLowerCase()] ?? "";
const setCookies = (page: FetchedPage) => header(page, "set-cookie");

const CHECKS: Record<string, Check> = {
  doctype: (page) => (/^\s*<!doctype html>/i.test(page.rawHtml) ? pass("Starts with <!doctype html>.") : fail("The document does not start with <!doctype html>, so browsers render it in quirks mode.")),

  "html-lang": (_p, $) => {
    const lang = $("html").attr("lang")?.trim() ?? "";
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang) ? pass(`<html lang="${lang}">.`) : fail(lang ? `<html lang="${lang}"> is not a valid BCP 47 tag.` : "<html> has no lang attribute.");
  },
  "document-language": (_p, $) => {
    const lang = $("html").attr("lang")?.trim() ?? "";
    return lang ? pass(`Page language set: <html lang="${lang}">.`) : fail("<html> has no lang attribute.");
  },

  "meta-charset": (page, $) => {
    const head = page.rawHtml.slice(0, 1024).toLowerCase();
    if (/<meta[^>]+charset=["']?utf-8/.test(head)) return pass("UTF-8 declared in the first 1024 bytes.");
    if (/charset=utf-8/i.test(header(page, "content-type"))) return warn("UTF-8 is only in the Content-Type header; also declare <meta charset=\"utf-8\"> first in <head>.");
    return $("meta[charset]").length ? warn("<meta charset> is present but not in the first 1024 bytes.") : fail("No UTF-8 declaration.");
  },

  "meta-viewport": (_p, $) => {
    const v = ($("meta[name='viewport']").attr("content") ?? "").toLowerCase();
    if (!v) return fail("No <meta name=\"viewport\">.");
    if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?(\D|$)/.test(v)) return fail(`Viewport disables zoom: "${v}".`);
    return v.includes("width=device-width") ? pass(`"${v}".`) : warn(`Viewport lacks width=device-width: "${v}".`);
  },

  title: (_p, $) => {
    const titles = $("head title");
    const text = titles.first().text().trim();
    if (titles.length === 1 && text) return pass(`"${text}".`);
    return fail(titles.length > 1 ? `${titles.length} <title> elements.` : "No non-empty <title> in <head>.");
  },

  "image-alt-text": (_p, $) => {
    const imgs = $("img");
    const missing = imgs.filter((_, el) => $(el).attr("alt") === undefined).length;
    if (!imgs.length) return pass("No <img> elements.");
    return missing ? fail(`${missing} of ${imgs.length} <img> lack an alt attribute.`) : pass(`All ${imgs.length} <img> have alt.`);
  },

  "form-labels": (_p, $) => {
    const controls = $("input, select, textarea").filter((_, el) => !/^(hidden|submit|button|reset|image)$/i.test($(el).attr("type") ?? ""));
    const unlabelled = controls.filter((_, el) => {
      const $el = $(el);
      const id = $el.attr("id");
      return !($el.attr("aria-label")?.trim() || $el.attr("aria-labelledby") || $el.attr("title")?.trim() || $el.closest("label").length || (id && $(`label[for='${id}']`).length));
    }).length;
    if (!controls.length) return pass("No form controls.");
    return unlabelled ? fail(`${unlabelled} of ${controls.length} form controls have no label.`) : pass(`All ${controls.length} form controls are labelled.`);
  },

  "skip-links": (_p, $) => {
    const first = $("body a[href], body button, body input:not([type='hidden']), body select, body textarea").first();
    const href = first.attr("href") ?? "";
    return href.startsWith("#") && /skip/i.test(first.text()) ? pass(`First focusable element: "${first.text().trim()}" → ${href}.`) : fail("The first focusable element is not a skip link.");
  },

  "semantic-html": (_p, $) => {
    const has = ["main", "nav", "header", "footer"].filter((t) => $(t).length);
    if (!$("main").length) return fail("No <main> landmark.");
    return has.length === 4 ? pass("<main>, <nav>, <header> and <footer> present.") : warn(`Landmarks present: ${has.join(", ")}.`);
  },

  "link-text": (_p, $) => {
    const vague = /^(click here|here|read more|more|link|this|learn more)$/i;
    const bad = $("a[href]").filter((_, el) => {
      const $el = $(el);
      const text = ($el.text().trim() || $el.attr("aria-label") || $el.find("img").attr("alt") || "").trim();
      return !text || (vague.test(text) && !$el.attr("aria-label"));
    }).length;
    return bad ? warn(`${bad} link(s) with empty or generic text.`) : pass("Every link has descriptive text.");
  },

  "data-tables": (_p, $) => {
    const tables = $("table");
    if (!tables.length) return pass("No data tables.");
    const noHeaders = tables.filter((_, el) => !$(el).find("th").length).length;
    return noHeaders ? fail(`${noHeaders} of ${tables.length} tables have no <th> header cells.`) : pass(`All ${tables.length} tables have header cells.`);
  },

  "heading-hierarchy": (_p, $) => {
    const levels = $("h1, h2, h3, h4, h5, h6").map((_, el) => Number(el.tagName.slice(1))).get();
    if (!levels.includes(1)) return fail("No <h1>.");
    const skips = levels.filter((l, i) => i > 0 && l > levels[i - 1]! + 1).length;
    return skips ? warn(`${skips} skipped heading level(s).`) : pass(`${levels.length} headings, no skipped levels.`);
  },

  "image-optimization": (_p, $) => {
    const imgs = $("img");
    if (!imgs.length) return pass("No <img> elements.");
    const unsized = imgs.filter((_, el) => !$(el).attr("width") || !$(el).attr("height")).length;
    return unsized ? warn(`${unsized} of ${imgs.length} <img> lack width/height (layout shift).`) : pass(`All ${imgs.length} <img> have explicit dimensions.`);
  },

  "https-tls": (page) => (page.finalUrl.startsWith("https://") ? pass(`Served over HTTPS: ${page.finalUrl}.`) : fail(`Final URL is not HTTPS: ${page.finalUrl}.`)),

  hsts: (page) => {
    const v = header(page, "strict-transport-security");
    const age = Number(v.match(/max-age=(\d+)/i)?.[1] ?? 0);
    if (!v) return fail("No Strict-Transport-Security header.");
    return age >= 15_552_000 ? pass(`"${v}".`) : warn(`max-age is under six months: "${v}".`);
  },

  "x-content-type-options": (page) => (/nosniff/i.test(header(page, "x-content-type-options")) ? pass("X-Content-Type-Options: nosniff.") : fail("No X-Content-Type-Options: nosniff.")),

  "frame-ancestors": (page) => {
    const csp = header(page, "content-security-policy");
    if (/frame-ancestors/i.test(csp)) return pass(`CSP ${csp.match(/frame-ancestors[^;]*/i)?.[0]}.`);
    return /^(deny|sameorigin)$/i.test(header(page, "x-frame-options").trim()) ? pass(`X-Frame-Options: ${header(page, "x-frame-options")}.`) : fail("Neither CSP frame-ancestors nor X-Frame-Options.");
  },

  "cache-control": (page) => {
    const v = header(page, "cache-control");
    return v ? pass(`Cache-Control: ${v}.`) : warn("No Cache-Control header on the HTML.");
  },

  compression: (page) => {
    const enc = header(page, "content-encoding");
    return /br|gzip|zstd|deflate/i.test(enc) ? pass(`Content-Encoding: ${enc}.`) : fail("HTML is not compressed.");
  },

  "privacy-policy": (_p, $) => {
    const link = $("a[href]").filter((_, el) => /privacy/i.test(`${$(el).text()} ${$(el).attr("href")}`)).first();
    return link.length ? pass(`Linked: ${link.attr("href")}.`) : fail("No link to a privacy policy.");
  },

  "cookie-consent": (page) => (setCookies(page) ? warn("The page sets cookies on first load; check none are non-essential before consent.") : pass("No cookies set on first load.")),

  "cookie-attributes": (page) => {
    const raw = setCookies(page);
    if (!raw) return pass("No cookies set.");
    const ok = /secure/i.test(raw) && /samesite/i.test(raw);
    return ok ? pass("Cookies carry Secure and SameSite.") : fail("A cookie lacks Secure or SameSite.");
  },

  "meta-robots": (page, $) => {
    const meta = ($("meta[name='robots']").attr("content") ?? "").toLowerCase();
    const tag = header(page, "x-robots-tag").toLowerCase();
    if (/noindex/.test(meta) || /noindex/.test(tag)) return warn(`This page is noindex (${meta || tag}); confirm that is intended.`);
    return pass(meta ? `meta robots "${meta}".` : "Indexable by default (no noindex).");
  },

  "error-pages": (_p, _$, extras) => {
    const nf = extras.notFound;
    if (!nf) return warn("Could not request a missing page.");
    if (nf.status !== 404) return fail(`A missing page returns ${nf.status}, not 404.`);
    return nf.html ? pass("A missing page returns 404 with an HTML page.") : warn("A missing page returns 404 but no HTML page.");
  },

  redirects: (_p, _$, extras) => {
    const r = extras.httpRedirect;
    if (!r) return warn("Could not request the plain-http URL.");
    if (r.status === 301 || r.status === 308) return pass(`http:// → ${r.status} ${r.location ?? ""}.`);
    if (r.status === 302 || r.status === 307) return warn(`http:// → temporary ${r.status}; use 301 or 308.`);
    return fail(`http:// answers ${r.status} instead of redirecting to https.`);
  },
};

/** The slug a spec item's reference URL ends with, e.g. ".../security/hsts/" → "hsts". */
export function specSlug(reference: string | undefined): string | null {
  const m = reference?.match(/\/spec\/[^/]+\/([^/?#]+)\/?/);
  return m?.[1] ?? null;
}

export function verifySpecItem(slug: string | null, page: FetchedPage, $: cheerio.CheerioAPI, extras: SpecExtras): SpecVerdict | null {
  const check = slug ? CHECKS[slug] : undefined;
  return check ? check(page, $, extras) : null;
}
