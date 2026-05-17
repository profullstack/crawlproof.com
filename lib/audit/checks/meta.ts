import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

// Discoverability / crawl-control signals that live in <head> or response
// headers. These don't belong with the "Homepage Audit" content checks but
// are still surfaced under that section to keep the report compact.
export function checkMeta(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home?.rawHtml) return out;
  const $ = cheerio.load(home.rawHtml);

  // <meta name="robots"> — explicit noindex/nofollow at page level.
  const robotsMeta = $("meta[name='robots']").attr("content")?.trim().toLowerCase();
  const noindex = robotsMeta?.includes("noindex") ?? false;
  if (noindex) {
    out.push({
      section: "Homepage Audit",
      check_key: "meta.robots_noindex",
      status: "fail",
      title: "Homepage is marked noindex",
      detail: `<meta name="robots" content="${robotsMeta}"> — search and AI engines will not index this page.`,
      evidence: { content: robotsMeta },
      priority: 1,
    });
  } else if (robotsMeta) {
    out.push({
      section: "Homepage Audit",
      check_key: "meta.robots",
      status: "pass",
      title: `Robots meta: "${robotsMeta}"`,
      evidence: { content: robotsMeta },
      priority: 5,
    });
  }

  // X-Robots-Tag — same intent as meta robots, but at the response-header
  // layer where it's easier to miss.
  const xRobots = home.headers["x-robots-tag"]?.toLowerCase();
  if (xRobots?.includes("noindex")) {
    out.push({
      section: "Homepage Audit",
      check_key: "meta.x_robots_noindex",
      status: "fail",
      title: "Homepage has X-Robots-Tag: noindex",
      detail: `Response header "X-Robots-Tag: ${xRobots}" tells crawlers not to index the page.`,
      evidence: { header: xRobots },
      priority: 1,
    });
  }

  // hreflang — multilingual sites need alternates declared so AI engines
  // route the right language to the right query.
  const hreflangs = $("link[rel='alternate'][hreflang]")
    .map((_, el) => $(el).attr("hreflang"))
    .get()
    .filter(Boolean) as string[];
  if (hreflangs.length > 0) {
    const hasXDefault = hreflangs.includes("x-default");
    out.push({
      section: "Homepage Audit",
      check_key: "meta.hreflang",
      status: hasXDefault ? "pass" : "warn",
      title: `hreflang: ${hreflangs.length} alternate(s)${hasXDefault ? "" : " (no x-default)"}`,
      detail: hasXDefault
        ? `Locales: ${hreflangs.join(", ")}`
        : `Add hreflang="x-default" for the fallback page so engines know which version to show outside declared locales.`,
      evidence: { hreflangs },
      priority: hasXDefault ? 5 : 3,
    });
  }

  // Favicon — small signal, but its absence makes AI agents fall back to
  // generic icons in citation cards.
  const favicon =
    $("link[rel='icon']").attr("href") ||
    $("link[rel='shortcut icon']").attr("href") ||
    $("link[rel='apple-touch-icon']").attr("href");
  out.push({
    section: "Homepage Audit",
    check_key: "meta.favicon",
    status: favicon ? "pass" : "warn",
    title: favicon ? "Favicon declared" : "Favicon missing",
    detail: favicon
      ? undefined
      : 'Add `<link rel="icon" href="/favicon.ico">` (and an apple-touch-icon) so AI citation cards have a brand mark.',
    evidence: favicon ? { href: favicon } : undefined,
    priority: favicon ? 5 : 4,
  });

  // Charset — most pages have it, but a missing or wrong charset breaks
  // unicode content for some crawlers.
  const charset =
    $("meta[charset]").attr("charset") ||
    $("meta[http-equiv='Content-Type']").attr("content");
  if (!charset) {
    out.push({
      section: "Homepage Audit",
      check_key: "meta.charset",
      status: "warn",
      title: "Charset not declared",
      detail: 'Add `<meta charset="utf-8">` as the first child of <head>.',
      priority: 3,
    });
  }

  return out;
}
