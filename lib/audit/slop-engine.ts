// Slop Score engine — free, deterministic, no LLM.
//
// Unlike the `rule` engine (which samples 8 linked pages to judge AEO basics),
// this one sweeps up to 50 pages, because the most damning slop signals are
// cross-page: near-duplicate bodies, templated metadata nobody filled in,
// the same boilerplate intro on thirty pages. One page can't show you that.
//
// Page discovery: sitemap.xml (including sitemap indexes) first, since that's
// the site's own claim about what it publishes, then breadth-first from the
// homepage to fill the remaining budget. Same-origin only.
//
// It also fetches a handful of same-origin stylesheets so the design checks
// can see palette / typography / !important sprawl, which is invisible from
// HTML alone.

import * as cheerio from "cheerio";
import { fetchPage } from "./fetch";
import { scoreFindings } from "./score";
import {
  buildSlopReport,
  slopFindings,
  slopMarkdown,
  toSlopPage,
  type SlopPage,
  type SlopStylesheet,
} from "./checks/slop";
import type { AuditResult, Finding } from "./types";

type SlopAuditResult = AuditResult & { markdown: string };

export const MAX_PAGES = 50;
const MAX_STYLESHEETS = 6;
const MAX_CSS_BYTES = 1.5 * 1024 * 1024;
const CONCURRENCY = 6;
const DEADLINE_MS = 3 * 60 * 1000; // stay well inside the worker's 7-min cutoff

const SKIP_EXT_RE =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|tar|mp4|webm|mp3|wav|woff2?|ttf|eot|rss|atom)(?:$|\?)/i;

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Trailing slash is not a distinct page for our purposes; collapsing it
    // stops "/about" and "/about/" from eating two slots and then reporting
    // themselves as near-duplicates of each other.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url;
  }
}

/** Pull <loc> URLs out of a sitemap or sitemap index, following nested indexes once. */
async function sitemapUrls(origin: string, deadline: number): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  async function readSitemap(url: string, depth: number): Promise<void> {
    if (depth > 1 || out.length >= MAX_PAGES * 3 || Date.now() > deadline) return;
    const res = await fetchPage(url);
    if (res.status < 200 || res.status >= 300 || !res.rawHtml) return;
    const $ = cheerio.load(res.rawHtml, { xmlMode: true });

    const nested = $("sitemapindex > sitemap > loc")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((u) => u && sameOrigin(u, origin));
    for (const n of nested.slice(0, 5)) {
      if (seen.has(n)) continue;
      seen.add(n);
      await readSitemap(n, depth + 1);
    }

    for (const loc of $("urlset > url > loc").map((_, el) => $(el).text().trim()).get()) {
      if (!loc || !sameOrigin(loc, origin) || SKIP_EXT_RE.test(loc)) continue;
      const n = normalize(loc);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }

  await readSitemap(`${origin}/sitemap.xml`, 0);
  return out;
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await worker(items[i]!);
      }
    }),
  );
  return out;
}

function linksFrom(html: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (/^(?:mailto:|tel:|javascript:|#)/i.test(href.trim())) return;
    let abs: string;
    try {
      abs = new URL(href, origin).toString();
    } catch {
      return;
    }
    if (!sameOrigin(abs, origin) || SKIP_EXT_RE.test(abs)) return;
    out.push(normalize(abs));
  });
  return out;
}

function stylesheetHrefs(html: string, origin: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $("link[rel='stylesheet'][href], link[as='style'][href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, origin).toString();
      if (sameOrigin(abs, origin)) out.push(abs);
    } catch {
      /* skip */
    }
  });
  return out;
}

export async function slopAudit(
  targetUrl: string,
  options: { maxPages?: number } = {},
): Promise<SlopAuditResult> {
  const started = Date.now();
  const deadline = started + DEADLINE_MS;
  const maxPages = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES);

  let origin: string;
  let root: string;
  try {
    const u = new URL(targetUrl);
    origin = u.origin;
    root = normalize(`${u.origin}${u.pathname}`);
  } catch {
    const findings: Finding[] = [
      {
        section: "Slop Score",
        check_key: "slop.crawl_error",
        status: "fail",
        title: "Could not parse the target URL",
        detail: `"${targetUrl}" is not a valid absolute http(s) URL.`,
        priority: 1,
      },
    ];
    return {
      score: scoreFindings(findings),
      findings,
      markdown: `# Slop Score — ${targetUrl}\n\nThe target URL could not be parsed.\n`,
      summary: {
        pagesCrawled: 0,
        pass: 0,
        warn: 0,
        fail: 1,
        unknown: 0,
        dataFound: [],
        durationMs: Date.now() - started,
      },
    };
  }

  // 1. Fetch the entry page first — it seeds both link discovery and the
  //    stylesheet list.
  const first = await fetchPage(root);
  const fetched = new Map<string, SlopPage>();
  const visited = new Set<string>([root]);
  if (first.rawHtml || first.status > 0) {
    fetched.set(root, toSlopPage({ url: root, status: first.status, html: first.rawHtml }));
  }

  if (first.status === 0 || !first.rawHtml) {
    const findings: Finding[] = [
      {
        section: "Slop Score",
        check_key: "slop.crawl_error",
        status: "fail",
        title: "Could not fetch the page",
        detail: `${root} returned ${first.status || "no response"}${first.error ? ` — ${first.error}` : ""}. Nothing to analyze.`,
        evidence: { url: root, status: first.status, error: first.error ?? null },
        priority: 1,
      },
    ];
    return {
      score: scoreFindings(findings),
      findings,
      markdown: `# Slop Score — ${targetUrl}\n\nThe page could not be fetched (${first.status || "no response"}).\n`,
      summary: {
        pagesCrawled: 0,
        pass: 0,
        warn: 0,
        fail: 1,
        unknown: 0,
        dataFound: [],
        durationMs: Date.now() - started,
      },
    };
  }

  // 2. Build the queue: sitemap first (the site's own inventory), then BFS.
  const queue: string[] = [];
  const enqueue = (url: string) => {
    if (visited.has(url) || queue.includes(url)) return;
    queue.push(url);
  };
  for (const u of await sitemapUrls(origin, deadline)) enqueue(u);
  for (const u of linksFrom(first.rawHtml, origin)) enqueue(u);

  // 3. Crawl until the page budget, queue, or deadline runs out.
  let capped = false;
  while (fetched.size < maxPages && queue.length > 0) {
    if (Date.now() > deadline) {
      capped = true;
      break;
    }
    const batch = queue.splice(0, Math.min(CONCURRENCY, maxPages - fetched.size));
    for (const u of batch) visited.add(u);
    const pages = await mapLimit(batch, CONCURRENCY, (u) => fetchPage(u));
    for (const p of pages) {
      // Skip non-HTML responses that slipped past the extension filter.
      if (p.contentType && !/text\/html|application\/xhtml/i.test(p.contentType)) continue;
      if (!p.rawHtml) continue;
      const url = normalize(p.url);
      if (fetched.has(url)) continue;
      fetched.set(url, toSlopPage({ url, status: p.status, html: p.rawHtml }));
      // Keep widening only while we still have budget to spend.
      if (fetched.size + queue.length < maxPages * 2) {
        for (const l of linksFrom(p.rawHtml, origin)) enqueue(l);
      }
    }
  }
  if (queue.length > 0) capped = true;

  // 4. Stylesheets for the design checks.
  const cssUrls = Array.from(new Set(stylesheetHrefs(first.rawHtml, origin))).slice(0, MAX_STYLESHEETS);
  const stylesheets: SlopStylesheet[] = [];
  if (cssUrls.length > 0 && Date.now() < deadline) {
    const cssPages = await mapLimit(cssUrls, 3, (u) => fetchPage(u));
    let bytes = 0;
    for (const c of cssPages) {
      if (c.status < 200 || c.status >= 300 || !c.rawHtml) continue;
      if (bytes + c.rawHtml.length > MAX_CSS_BYTES) break;
      bytes += c.rawHtml.length;
      stylesheets.push({ url: c.url, css: c.rawHtml });
    }
  }

  // 5. Analyze + report.
  const pages = Array.from(fetched.values());
  const report = buildSlopReport(pages, stylesheets);
  const findings = slopFindings(report, maxPages);

  findings.push({
    section: "Slop Score",
    check_key: "slop.coverage",
    status: capped ? "warn" : "pass",
    title: capped
      ? `Crawl capped at ${pages.length} page${pages.length === 1 ? "" : "s"} (${maxPages}-page limit)`
      : `Swept ${pages.length} page${pages.length === 1 ? "" : "s"}`,
    detail: capped
      ? `The site has more pages than the ${maxPages}-page budget for this scan, so pages beyond that were not analyzed. The score reflects what was crawled.`
      : `Crawled every discoverable same-origin page from ${root} (sitemap.xml + internal links), plus ${stylesheets.length} stylesheet${stylesheets.length === 1 ? "" : "s"}.`,
    evidence: {
      pagesCrawled: pages.length,
      maxPages,
      capped,
      stylesheets: stylesheets.map((s) => s.url),
      urls: pages.map((p) => p.url),
    },
    priority: 5,
  });

  // The headline slop.score finding summarizes the others, and the systemic
  // rollups restate defects already counted per page — both are excluded from
  // the 0-100 AEO score so nothing is counted twice.
  const scored = findings.filter(
    (f) => f.check_key !== "slop.score" && !f.check_key.startsWith("slop.systemic."),
  );

  return {
    score: scoreFindings(scored),
    findings,
    markdown: slopMarkdown({
      targetUrl,
      report,
      crawled: pages.length,
      capped,
      durationMs: Date.now() - started,
      maxPages,
    }),
    summary: {
      pagesCrawled: pages.length,
      pass: findings.filter((f) => f.status === "pass").length,
      warn: findings.filter((f) => f.status === "warn").length,
      fail: findings.filter((f) => f.status === "fail").length,
      unknown: findings.filter((f) => f.status === "unknown").length,
      dataFound: [],
      durationMs: Date.now() - started,
      // Surfaced separately so the UI and share cards can render the number
      // without re-deriving it from findings.
      slopScore: report.score,
      slopGrade: report.grade,
      slopByDimension: report.byDimension,
      slopIssues: report.totals.issues,
    } as AuditResult["summary"] & {
      slopScore: number;
      slopGrade: string;
      slopByDimension: Record<string, number>;
      slopIssues: number;
    },
  };
}
