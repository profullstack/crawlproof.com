import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

// Static performance signals derivable from the HTML we already fetched.
// We don't run Lighthouse — these are cheap heuristics that align with
// what AI crawlers actually experience (no JS execution by default).
export function checkPerformance(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home?.rawHtml) return out;

  // Page weight. AI crawlers cap response sizes; over ~1.5MB and many bots
  // will truncate the document.
  const kb = home.bytes / 1024;
  out.push({
    section: "Performance",
    check_key: "perf.page_size",
    status: kb < 500 ? "pass" : kb < 1500 ? "warn" : "fail",
    title: `Page size: ${kb.toFixed(0)} KB`,
    detail:
      kb < 500
        ? "Compact HTML payload — well within AI crawler limits."
        : kb < 1500
          ? "Heavier than recommended. Trim inline scripts/styles or split lazy chunks."
          : "Very large. AI crawlers commonly truncate documents over 1.5 MB.",
    evidence: { bytes: home.bytes },
    priority: kb < 500 ? 5 : kb < 1500 ? 3 : 1,
  });

  // Resource counts. Many script tags = many round-trips when crawlers do
  // attempt to follow them. We count HTML requests, not actual fetches.
  const $ = cheerio.load(home.rawHtml);
  const scripts = $("script[src]").length;
  const inlineScripts = $("script:not([src])").length;
  const styles = $("link[rel='stylesheet']").length;
  const inlineStyles = $("style").length;
  const imgs = $("img").length;
  const totalRequests = scripts + styles + imgs;

  out.push({
    section: "Performance",
    check_key: "perf.resource_count",
    status: totalRequests < 40 ? "pass" : totalRequests < 80 ? "warn" : "fail",
    title: `Resource requests: ${totalRequests} (scripts:${scripts}, css:${styles}, img:${imgs})`,
    detail:
      totalRequests < 40
        ? "Reasonable request count."
        : "High request count. Bundle scripts/styles and use sprites or CSS for icons.",
    evidence: { scripts, styles, imgs, inlineScripts, inlineStyles },
    priority: totalRequests < 40 ? 5 : totalRequests < 80 ? 3 : 2,
  });

  // Render-blocking head resources — scripts/styles in <head> without
  // async/defer block first paint.
  const blockingScripts = $("head script[src]")
    .filter((_, el) => !$(el).attr("async") && !$(el).attr("defer"))
    .length;
  out.push({
    section: "Performance",
    check_key: "perf.render_blocking",
    status: blockingScripts === 0 ? "pass" : blockingScripts <= 2 ? "warn" : "fail",
    title:
      blockingScripts === 0
        ? "No render-blocking head scripts"
        : `${blockingScripts} render-blocking script(s) in <head>`,
    detail:
      blockingScripts === 0
        ? "All head scripts use async or defer."
        : "Move non-critical scripts to end of <body> or add `defer`/`async`.",
    priority: blockingScripts === 0 ? 5 : blockingScripts <= 2 ? 3 : 2,
  });

  // Inline JS/CSS bulk — large inline blocks delay parsing.
  let inlineJsBytes = 0;
  $("script:not([src])").each((_, el) => {
    inlineJsBytes += ($(el).text() || "").length;
  });
  let inlineCssBytes = 0;
  $("style").each((_, el) => {
    inlineCssBytes += ($(el).text() || "").length;
  });
  const inlineKb = (inlineJsBytes + inlineCssBytes) / 1024;
  if (inlineKb >= 1) {
    out.push({
      section: "Performance",
      check_key: "perf.inline_bulk",
      status: inlineKb < 50 ? "pass" : inlineKb < 200 ? "warn" : "fail",
      title: `Inline JS+CSS bulk: ${inlineKb.toFixed(0)} KB`,
      detail:
        inlineKb < 50
          ? "Inline payload is modest."
          : "Move large inline scripts/styles to external files to enable caching.",
      evidence: { inlineJsBytes, inlineCssBytes },
      priority: inlineKb < 50 ? 5 : inlineKb < 200 ? 3 : 2,
    });
  }

  // TTFB proxy — we don't have a true TTFB, but fetchMs gives an
  // approximate response time when the page is small.
  if (home.bytes < 200 * 1024) {
    out.push({
      section: "Performance",
      check_key: "perf.response_time",
      status: home.fetchMs < 600 ? "pass" : home.fetchMs < 1500 ? "warn" : "fail",
      title: `Response time: ${home.fetchMs}ms`,
      detail:
        home.fetchMs < 600
          ? "Fast first response."
          : "Slow response. Check CDN/cache headers and origin latency.",
      evidence: { fetchMs: home.fetchMs, bytes: home.bytes },
      priority: home.fetchMs < 600 ? 5 : home.fetchMs < 1500 ? 3 : 2,
    });
  }

  // Cache-Control / CDN signals
  const cc = home.headers["cache-control"];
  const cdnHints = [
    home.headers["cf-ray"] && "Cloudflare",
    home.headers["x-vercel-id"] && "Vercel",
    home.headers["x-amz-cf-id"] && "CloudFront",
    home.headers["x-served-by"] && `Fastly/${home.headers["x-served-by"]}`,
    home.headers["server"]?.toLowerCase().includes("netlify") && "Netlify",
  ].filter(Boolean) as string[];
  out.push({
    section: "Performance",
    check_key: "perf.caching",
    status: cc ? "pass" : "warn",
    title: cc ? `Cache-Control set${cdnHints.length ? ` (CDN: ${cdnHints[0]})` : ""}` : "No Cache-Control header",
    detail: cc
      ? `Cache-Control: ${cc}${cdnHints.length ? `\nCDN detected: ${cdnHints.join(", ")}` : ""}`
      : "Add a Cache-Control header so CDNs and AI crawlers can revalidate efficiently.",
    evidence: { cacheControl: cc, cdn: cdnHints },
    priority: cc ? 5 : 3,
  });

  return out;
}
