import * as cheerio from "cheerio";
import type { CrawlContext, Finding } from "../types";

const MODERN_FORMATS = /\.(webp|avif)(\?|#|$)/i;
const LEGACY_FORMATS = /\.(png|jpg|jpeg|gif)(\?|#|$)/i;

// Image-level checks separate from alt-text (which lives in homepage.ts).
// Focus is on signals AI page-quality models weigh: modern formats, lazy
// loading, explicit dimensions, srcset for responsive delivery.
export function checkImages(ctx: CrawlContext): Finding[] {
  const home = ctx.pages[ctx.target];
  const out: Finding[] = [];
  if (!home?.rawHtml) return out;
  const $ = cheerio.load(home.rawHtml);
  const imgs = $("img").get();
  if (imgs.length === 0) return out;

  let modern = 0;
  let legacy = 0;
  let lazy = 0;
  let withDims = 0;
  let withSrcset = 0;
  for (const img of imgs) {
    const $i = $(img);
    const src = ($i.attr("src") || $i.attr("data-src") || "").trim();
    if (MODERN_FORMATS.test(src)) modern++;
    else if (LEGACY_FORMATS.test(src)) legacy++;
    if (($i.attr("loading") || "").toLowerCase() === "lazy") lazy++;
    if ($i.attr("width") && $i.attr("height")) withDims++;
    if ($i.attr("srcset")) withSrcset++;
  }

  const formatPct = imgs.length === 0 ? 0 : modern / imgs.length;
  out.push({
    section: "Links & Images",
    check_key: "images.format",
    status: legacy === 0 && modern > 0 ? "pass" : modern > legacy ? "warn" : legacy > 0 ? "warn" : "warn",
    title: `Modern image formats: ${(formatPct * 100).toFixed(0)}% (${modern}/${imgs.length} webp/avif)`,
    detail:
      legacy === 0 && modern > 0
        ? "All raster images use modern formats."
        : `${legacy} legacy (png/jpg/gif) image(s). Convert hero/above-the-fold images to WebP or AVIF.`,
    evidence: { modern, legacy, total: imgs.length },
    priority: legacy === 0 && modern > 0 ? 5 : 3,
  });

  // Lazy loading — required for below-the-fold images to keep page speed
  // under crawler budgets. We grade against image count, not viewport.
  if (imgs.length >= 4) {
    const lazyPct = lazy / imgs.length;
    out.push({
      section: "Links & Images",
      check_key: "images.lazy_loading",
      status: lazyPct >= 0.5 ? "pass" : lazyPct >= 0.2 ? "warn" : "fail",
      title: `Lazy loading: ${(lazyPct * 100).toFixed(0)}% (${lazy}/${imgs.length})`,
      detail:
        lazyPct >= 0.5
          ? "Most below-the-fold images defer load — good for perf and crawl budgets."
          : 'Add `loading="lazy"` to below-the-fold images to reduce initial payload.',
      evidence: { lazy, total: imgs.length },
      priority: lazyPct >= 0.5 ? 5 : 3,
    });
  }

  // Explicit dimensions prevent CLS, which Core Web Vitals scores heavily.
  const dimsPct = withDims / imgs.length;
  out.push({
    section: "Links & Images",
    check_key: "images.dimensions",
    status: dimsPct >= 0.8 ? "pass" : dimsPct >= 0.4 ? "warn" : "fail",
    title: `Explicit dimensions: ${(dimsPct * 100).toFixed(0)}% (${withDims}/${imgs.length})`,
    detail:
      dimsPct >= 0.8
        ? "Most images have width/height — avoids layout shift."
        : "Add width and height attributes on <img> tags to prevent CLS.",
    evidence: { withDims, total: imgs.length },
    priority: dimsPct >= 0.8 ? 5 : 3,
  });

  // srcset — responsive variants help mobile crawl budgets.
  if (imgs.length >= 4) {
    out.push({
      section: "Links & Images",
      check_key: "images.srcset",
      status: withSrcset >= Math.min(2, imgs.length) ? "pass" : "warn",
      title: `Responsive srcset: ${withSrcset}/${imgs.length}`,
      detail:
        withSrcset >= Math.min(2, imgs.length)
          ? undefined
          : "Use srcset/sizes to serve appropriately-sized images on mobile. Reduces wasted bytes.",
      priority: withSrcset > 0 ? 5 : 4,
    });
  }

  return out;
}
