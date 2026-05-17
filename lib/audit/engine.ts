import * as cheerio from "cheerio";
import { fetchPage, probeText } from "./fetch";
import { attachRendered } from "./render";
import { checkHomepage } from "./checks/homepage";
import { checkSchema } from "./checks/schema";
import { checkRobotsAndSitemap } from "./checks/robots";
import { checkPositioning } from "./checks/positioning";
import { collectDataPoints } from "./checks/dataPoints";
import { checkMeta } from "./checks/meta";
import { checkContent } from "./checks/content";
import { checkImages } from "./checks/images";
import { checkLinks } from "./checks/links";
import { checkSecurity } from "./checks/security";
import { checkPerformance } from "./checks/performance";
import { scoreFindings } from "./score";
import { deriveRecommendations } from "./recommendations";
import type { AuditResult, CrawlContext, FetchedPage, Finding } from "./types";

const PRIORITY_PATHS = [
  "/about",
  "/pricing",
  "/blog",
  "/docs",
  "/contact",
  "/team",
  "/customers",
  "/security",
  "/features",
  "/changelog",
];

const PRIVATE_HOSTS = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|fc00:|fd00:)/i;

function normalizeTarget(input: string): { target: string; origin: string; host: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    url = new URL(`https://${input}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are supported.");
  if (PRIVATE_HOSTS.test(url.hostname)) {
    throw new Error("Refusing to audit private/localhost addresses.");
  }
  url.hash = "";
  return {
    target: url.toString().replace(/\/$/, "") || url.origin + "/",
    origin: url.origin,
    host: url.hostname,
  };
}

function absolutize(origin: string, href: string): string | null {
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
}

function discoverLinks(home: FetchedPage, origin: string): string[] {
  if (!home.rawHtml) return [];
  const $ = cheerio.load(home.rawHtml);
  const links = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const abs = absolutize(origin, href);
    if (!abs) return;
    try {
      const u = new URL(abs);
      if (u.origin !== origin) return;
      links.add(u.toString().replace(/#.*$/, ""));
    } catch {
      /* skip */
    }
  });

  const sorted = Array.from(links).sort((a, b) => {
    const ap = PRIORITY_PATHS.findIndex((p) => a.toLowerCase().includes(p));
    const bp = PRIORITY_PATHS.findIndex((p) => b.toLowerCase().includes(p));
    return (ap === -1 ? 99 : ap) - (bp === -1 ? 99 : bp);
  });
  return sorted.slice(0, 8);
}

type EngineOptions = {
  renderHomepage?: boolean; // default true
  renderPricing?: boolean; // default true
  maxLinkedPages?: number; // default 8
};

export async function runAudit(
  input: string,
  options: EngineOptions = {},
): Promise<AuditResult & { context: CrawlContext }> {
  const started = Date.now();
  const { renderHomepage = true, renderPricing = true, maxLinkedPages = 8 } = options;
  const { target, origin } = normalizeTarget(input);

  // 1. Fetch homepage.
  const homepage = await fetchPage(target);
  // 2. Probe well-known files in parallel.
  const [robots, sitemap, llmsTxt, llmsFullTxt, skillMd, aiPlugin, securityTxt] = await Promise.all([
    probeText(`${origin}/robots.txt`),
    probeText(`${origin}/sitemap.xml`),
    probeText(`${origin}/llms.txt`),
    probeText(`${origin}/llms-full.txt`),
    probeText(`${origin}/skill.md`),
    probeText(`${origin}/.well-known/ai-plugin.json`),
    probeText(`${origin}/.well-known/security.txt`),
  ]);

  // 3. Render homepage with Playwright (best effort).
  const homepageRendered = renderHomepage ? await attachRendered(homepage) : homepage;

  // 4. Discover and fetch important linked pages.
  const linkedUrls = discoverLinks(homepageRendered, origin).slice(0, maxLinkedPages);
  const linkedPages = await Promise.all(linkedUrls.map((u) => fetchPage(u)));

  // 5. Optionally render /pricing if found.
  let pricingRendered: FetchedPage | null = null;
  if (renderPricing) {
    const pricing = linkedPages.find((p) => /\/pricing(\/|$)/i.test(p.url));
    if (pricing) pricingRendered = await attachRendered(pricing);
  }

  const pages: Record<string, FetchedPage> = {
    [target]: homepageRendered,
  };
  for (const p of linkedPages) {
    pages[p.url] = pricingRendered && pricingRendered.url === p.url ? pricingRendered : p;
  }

  const ctx: CrawlContext = {
    target,
    origin,
    host: new URL(target).hostname,
    pages,
    wellKnown: {
      robots: robots,
      sitemap: sitemap,
      llmsTxt: llmsTxt,
      llmsFullTxt: llmsFullTxt,
      skillMd: skillMd,
      aiPlugin: aiPlugin,
      securityTxt: securityTxt,
    },
    findings: [],
  };

  // 6. Run checks.
  const findings: Finding[] = [];

  // Crawl summary
  const okPages = Object.values(ctx.pages).filter((p) => p.status >= 200 && p.status < 400).length;
  findings.push({
    section: "Crawl Summary",
    check_key: "crawl.pages_fetched",
    status: okPages > 0 ? "pass" : "fail",
    title: `Fetched ${okPages} of ${Object.keys(ctx.pages).length} pages successfully`,
    detail: `Target: ${target}`,
    evidence: {
      target,
      origin,
      pages: Object.values(ctx.pages).map((p) => ({
        url: p.url,
        status: p.status,
        bytes: p.bytes,
        fetchMs: p.fetchMs,
      })),
    },
    priority: okPages > 0 ? 5 : 1,
  });

  findings.push(...checkHomepage(ctx));
  findings.push(...checkMeta(ctx));
  findings.push(...checkContent(ctx));
  findings.push(...checkSchema(ctx));
  findings.push(...checkImages(ctx));
  findings.push(...(await checkLinks(ctx)));
  findings.push(...checkPerformance(ctx));
  findings.push(...checkSecurity(ctx));
  findings.push(...checkRobotsAndSitemap(ctx));
  findings.push(...checkPositioning(ctx));

  // Data Found
  const data = collectDataPoints(ctx);
  for (const d of data) {
    findings.push({
      section: "Data Found",
      check_key: `data.${d.dataPoint.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      status: d.found ? "pass" : "warn",
      title: `${d.dataPoint}: ${d.found ? "found" : "not found"}`,
      detail: d.notes ?? undefined,
      evidence: { source: d.source, notes: d.notes },
      priority: d.found ? 5 : 3,
    });
  }

  // Missing or hard-to-find: turn data gaps into a single rolled-up section.
  const notFound = data.filter((d) => !d.found);
  if (notFound.length > 0) {
    findings.push({
      section: "Missing or Hard-to-Find Information",
      check_key: "missing.summary",
      status: notFound.length > 5 ? "fail" : "warn",
      title: `${notFound.length} data point(s) could not be found from public pages`,
      detail: notFound.map((d) => `· ${d.dataPoint}`).join("\n"),
      evidence: { missing: notFound.map((d) => d.dataPoint) },
      priority: notFound.length > 5 ? 1 : 3,
    });
  }

  // Recommended fixes (derived from failed/warn findings).
  const recs = deriveRecommendations(findings);
  for (const r of recs) {
    findings.push({
      section: "Recommended Fixes",
      check_key: `rec.${r.check_key}`,
      status: "warn",
      title: r.title,
      detail: r.how,
      evidence: { for: r.check_key },
      priority: r.priority,
    });
  }

  // Priority to-do — same list, sorted, just labeled differently for the report.
  for (const r of recs.slice(0, 20)) {
    findings.push({
      section: "Priority To-Do List",
      check_key: `todo.${r.check_key}`,
      status: "warn",
      title: `[ ] ${r.title}`,
      detail: r.how,
      evidence: { priority: r.priority },
      priority: r.priority,
    });
  }

  ctx.findings = findings;
  const score = scoreFindings(findings.filter((f) => !f.check_key.startsWith("rec.") && !f.check_key.startsWith("todo.")));
  const summary = {
    pagesCrawled: Object.keys(ctx.pages).length,
    pass: findings.filter((f) => f.status === "pass").length,
    warn: findings.filter((f) => f.status === "warn").length,
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
    dataFound: data.map((d) => ({
      dataPoint: d.dataPoint,
      found: d.found,
      source: d.source,
      notes: d.notes,
    })),
    durationMs: Date.now() - started,
  };

  return { score, findings, summary, context: ctx };
}
