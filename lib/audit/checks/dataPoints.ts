import * as cheerio from "cheerio";
import type { CrawlContext } from "../types";
import { DATA_POINTS, type DataPoint, type SourceLabel } from "../prompt";

export type DataPointResult = {
  dataPoint: DataPoint;
  found: boolean;
  source: SourceLabel | null;
  notes: string | null;
};

function inText(text: string, words: string[]) {
  const lower = text.toLowerCase();
  return words.find((w) => lower.includes(w.toLowerCase())) ?? null;
}

export function collectDataPoints(ctx: CrawlContext): DataPointResult[] {
  const home = ctx.pages[ctx.target];
  const homeHtml = home?.rawHtml ?? "";
  const homeText = home?.renderedText ?? (homeHtml ? cheerio.load(homeHtml).root().text() : "");

  function pageWithKeywordInText(words: string[]): { url: string; src: SourceLabel } | null {
    for (const [url, page] of Object.entries(ctx.pages)) {
      if (!page.rawHtml) continue;
      const $ = cheerio.load(page.rawHtml);
      const text = (page.renderedText ?? $.root().text()).toLowerCase();
      const hit = inText(text, words);
      if (hit) {
        const src: SourceLabel = url === ctx.target ? "Homepage" : "Other public sources";
        return { url, src };
      }
    }
    return null;
  }

  function findInNavOrFooter(re: RegExp): SourceLabel | null {
    if (!homeHtml) return null;
    const $ = cheerio.load(homeHtml);
    const navMatch = $("nav, header").find("a").toArray().some((a) => re.test($(a).text()) || re.test($(a).attr("href") ?? ""));
    if (navMatch) return "Navigation links";
    const footerMatch = $("footer").find("a").toArray().some((a) => re.test($(a).text()) || re.test($(a).attr("href") ?? ""));
    if (footerMatch) return "Footer links";
    return null;
  }

  const results: DataPointResult[] = [];

  // Pricing
  {
    const fromNav = findInNavOrFooter(/pricing|plans/i);
    const fromPage = Object.keys(ctx.pages).find((u) => /pricing|plans/i.test(u));
    results.push({
      dataPoint: "Pricing",
      found: !!(fromNav || fromPage),
      source: fromPage ? "Pricing page" : fromNav,
      notes: fromPage ?? null,
    });
  }

  // Customer logos / social proof
  {
    const hit = inText(homeText, ["trusted by", "used by", "customers include", "as featured in", "loved by"]);
    results.push({
      dataPoint: "Customer logos",
      found: !!hit,
      source: hit ? "Homepage" : null,
      notes: hit,
    });
    results.push({
      dataPoint: "Social proof",
      found: !!hit,
      source: hit ? "Homepage" : null,
      notes: hit,
    });
  }

  // Recent launches / blog activity
  {
    const blogLinked = findInNavOrFooter(/blog|changelog|updates|news/i);
    const blogPage = Object.keys(ctx.pages).find((u) => /blog|changelog|updates|news/i.test(u));
    results.push({
      dataPoint: "Recent launches",
      found: !!blogPage,
      source: blogPage ? "Press/news pages" : blogLinked,
      notes: blogPage ?? null,
    });
    results.push({
      dataPoint: "Blog post activity",
      found: !!blogPage,
      source: blogPage ? "Blog" : blogLinked,
      notes: blogPage ?? null,
    });
  }

  // New hires
  {
    const hit = inText(homeText, ["welcome to the team", "join us", "we hired"]);
    results.push({
      dataPoint: "New hires",
      found: !!hit,
      source: hit ? "Homepage" : null,
      notes: hit ?? "Often only on a /blog/team or LinkedIn page",
    });
  }

  // Headline copy
  {
    const $ = cheerio.load(homeHtml || "");
    const h1 = $("h1").first().text().trim();
    results.push({
      dataPoint: "Headline copy",
      found: !!h1,
      source: h1 ? "Homepage" : null,
      notes: h1 ? h1.slice(0, 200) : null,
    });
  }

  // Positioning
  {
    const hit = inText(homeText, ["we help", "platform for", "easiest way", "built for"]);
    results.push({
      dataPoint: "Positioning",
      found: !!hit,
      source: hit ? "Homepage" : null,
      notes: hit,
    });
  }

  // Executive team
  {
    const teamLink = findInNavOrFooter(/team|about|leadership/i);
    const teamPage = Object.keys(ctx.pages).find((u) => /team|about|leadership/i.test(u));
    results.push({
      dataPoint: "Executive team",
      found: !!teamPage,
      source: teamPage ? "About/team page" : teamLink,
      notes: teamPage ?? null,
    });
  }

  // Product/service descriptions
  {
    const productPage = Object.keys(ctx.pages).find((u) => /product|features|solutions|services/i.test(u));
    const hasMeta = homeHtml
      ? !!cheerio.load(homeHtml)("meta[name='description']").attr("content")
      : false;
    results.push({
      dataPoint: "Product/service descriptions",
      found: !!(productPage || hasMeta),
      source: productPage ? "Navigation links" : hasMeta ? "Homepage" : null,
      notes: productPage ?? (hasMeta ? "From meta description" : null),
    });
  }

  // Case studies / testimonials
  {
    const linked = findInNavOrFooter(/case[-\s]?stud|customer|stories|testimonials/i);
    const hit = inText(homeText, ["case study", "testimonial", "customer story"]);
    results.push({
      dataPoint: "Case studies or testimonials",
      found: !!(linked || hit),
      source: linked ?? (hit ? "Homepage" : null),
      notes: hit ?? null,
    });
  }

  // Contact / demo / signup paths
  {
    const linked = findInNavOrFooter(/contact|sales|demo|signup|sign[-\s]?up|get[-\s]?started|try|book/i);
    results.push({
      dataPoint: "Contact/demo/signup paths",
      found: !!linked,
      source: linked,
      notes: null,
    });
  }

  // Fill in any missing keys so output is stable.
  const seen = new Set(results.map((r) => r.dataPoint));
  for (const dp of DATA_POINTS) {
    if (!seen.has(dp)) results.push({ dataPoint: dp, found: false, source: null, notes: null });
  }
  return results;
}
