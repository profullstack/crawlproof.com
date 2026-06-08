// Link-checker engine — recursively crawls the target's root domain with
// linkinator (the same crawler as `npx linkinator <url> --recurse`) and turns
// the broken-link report into structured findings. Free; no LLM required.
//
// linkinator has no built-in page cap or AbortSignal, so we bound the crawl
// with its `linksToSkip` extension point: once we exceed a page / link / wall-
// clock budget the predicate returns true for every remaining link, which
// stops both checking and recursion. This keeps a runaway crawl well under the
// worker's 7-minute stuck-audit cutoff.

import { LinkChecker, LinkState, type LinkResult } from "linkinator";
import { scoreFindings } from "./score";
import type { AuditResult, Finding } from "./types";

type LinksAuditResult = AuditResult & { markdown: string };

const UA = "CrawlProofBot/1.0 (+https://crawlproof.com/bot)";

// Budgets — generous enough for a typical CrawlProof property, hard-capped so
// the worker can't blow past the 7-minute stuck-sweep cutoff.
const MAX_PAGES = 250; // distinct internal pages we recurse into
const MAX_LINKS = 5000; // total links checked (internal + external)
const DEADLINE_MS = 4 * 60 * 1000; // wall-clock crawl budget
const PER_LINK_TIMEOUT_MS = 10_000;
const CONCURRENCY = 25;

// How many broken links to enumerate in findings / markdown before truncating.
const MAX_BROKEN_LISTED = 50;

function rootOf(targetUrl: string): string {
  // Crawl from the root domain, not the submitted deep link — the user asked
  // the bot to sweep the whole property, not just one page.
  const u = new URL(targetUrl);
  return `${u.protocol}//${u.host}/`;
}

export async function linksAudit(targetUrl: string): Promise<LinksAuditResult> {
  const started = Date.now();
  const root = rootOf(targetUrl);

  const checker = new LinkChecker();
  let pagesCrawled = 0;
  let linksChecked = 0;
  let capped: null | "pages" | "links" | "time" = null;

  checker.on("pagestart", () => {
    pagesCrawled++;
  });

  // Doubles as the crawl's kill-switch: returning true marks a link SKIPPED,
  // which also prevents linkinator from recursing into it.
  const linksToSkip = async (link: string): Promise<boolean> => {
    // linkinator already skips non-http(s) schemes, but guard anyway.
    if (!/^https?:\/\//i.test(link)) return true;
    if (Date.now() - started > DEADLINE_MS) {
      capped ??= "time";
      return true;
    }
    if (pagesCrawled >= MAX_PAGES) {
      capped ??= "pages";
      return true;
    }
    if (linksChecked >= MAX_LINKS) {
      capped ??= "links";
      return true;
    }
    return false;
  };

  let result: { links: LinkResult[]; passed: boolean };
  try {
    result = await checker.check({
      path: root,
      recurse: true,
      concurrency: CONCURRENCY,
      timeout: PER_LINK_TIMEOUT_MS,
      userAgent: UA,
      retry: true,
      linksToSkip,
    });
  } catch (err) {
    const findings: Finding[] = [
      {
        section: "Links & Images",
        check_key: "links.crawl_error",
        status: "fail",
        title: "Link crawl could not start",
        detail: `linkinator failed to crawl ${root}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        priority: 1,
      },
    ];
    return {
      score: scoreFindings(findings),
      findings,
      markdown: `# Link Checker — ${root}\n\nThe crawl could not be started: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
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

  const checked = result.links.filter((l) => l.state !== LinkState.SKIPPED);
  linksChecked = checked.length;
  const broken = result.links.filter((l) => l.state === LinkState.BROKEN);
  const skipped = result.links.filter((l) => l.state === LinkState.SKIPPED);

  const findings = buildFindings({
    root,
    pagesCrawled,
    checked: checked.length,
    broken,
    skippedCount: skipped.length,
    capped,
  });

  return {
    score: scoreFindings(findings),
    findings,
    markdown: buildMarkdown({
      root,
      pagesCrawled,
      checked: checked.length,
      broken,
      skippedCount: skipped.length,
      capped,
      durationMs: Date.now() - started,
    }),
    summary: {
      pagesCrawled,
      pass: findings.filter((f) => f.status === "pass").length,
      warn: findings.filter((f) => f.status === "warn").length,
      fail: findings.filter((f) => f.status === "fail").length,
      unknown: findings.filter((f) => f.status === "unknown").length,
      dataFound: [],
      durationMs: Date.now() - started,
    },
  };
}

function statusLabel(l: LinkResult): string {
  if (l.status && l.status > 0) return String(l.status);
  return "no response";
}

type Agg = {
  root: string;
  pagesCrawled: number;
  checked: number;
  broken: LinkResult[];
  skippedCount: number;
  capped: null | "pages" | "links" | "time";
};

function buildFindings(agg: Agg): Finding[] {
  const { root, pagesCrawled, checked, broken, skippedCount, capped } = agg;
  const out: Finding[] = [];

  // Broken-link finding — the headline of a link checker.
  const brokenCount = broken.length;
  const status = brokenCount === 0 ? "pass" : brokenCount <= 2 ? "warn" : "fail";
  const priority: Finding["priority"] =
    brokenCount === 0 ? 5 : brokenCount <= 2 ? 3 : 1;
  out.push({
    section: "Links & Images",
    check_key: "links.crawl_broken",
    status,
    title:
      brokenCount === 0
        ? `No broken links across ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"}`
        : `${brokenCount} broken link${brokenCount === 1 ? "" : "s"} across ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"}`,
    detail:
      brokenCount === 0
        ? `Recursively checked ${checked} link${checked === 1 ? "" : "s"} from ${root} — all resolved 2xx/3xx.`
        : broken
            .slice(0, MAX_BROKEN_LISTED)
            .map(
              (b) =>
                `· ${statusLabel(b)} — ${b.url}${b.parent ? `  (on ${b.parent})` : ""}`,
            )
            .join("\n") +
          (brokenCount > MAX_BROKEN_LISTED
            ? `\n… and ${brokenCount - MAX_BROKEN_LISTED} more`
            : ""),
    evidence: {
      root,
      pagesCrawled,
      linksChecked: checked,
      broken: brokenCount,
      examples: broken.slice(0, 10).map((b) => ({
        url: b.url,
        status: b.status ?? 0,
        parent: b.parent ?? null,
      })),
    },
    priority,
  });

  // Coverage summary — gives the reader confidence in the broken-link number
  // and flags when the crawl was budget-capped (so "0 broken" isn't read as a
  // clean bill of health for a site we only partially swept).
  out.push({
    section: "Links & Images",
    check_key: "links.crawl_coverage",
    status: capped ? "warn" : "pass",
    title: capped
      ? `Crawl capped at ${pagesCrawled} pages (${cappedReason(capped)})`
      : `Crawled ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"}, ${checked} link${checked === 1 ? "" : "s"}`,
    detail: capped
      ? `The recursive crawl hit the ${cappedReason(capped)} budget and stopped early, so links beyond that point were not checked. Re-run on a narrower section, or treat this as a partial sweep.`
      : `Full recursive sweep of ${root}: ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} crawled, ${checked} link${checked === 1 ? "" : "s"} checked${skippedCount ? `, ${skippedCount} skipped` : ""}.`,
    evidence: { capped: capped ?? false, pagesCrawled, linksChecked: checked, skipped: skippedCount },
    priority: 5,
  });

  return out;
}

function cappedReason(capped: "pages" | "links" | "time"): string {
  return capped === "pages"
    ? `${MAX_PAGES}-page`
    : capped === "links"
      ? `${MAX_LINKS}-link`
      : `${Math.round(DEADLINE_MS / 60000)}-minute`;
}

function buildMarkdown(agg: Agg & { durationMs: number }): string {
  const { root, pagesCrawled, checked, broken, skippedCount, capped, durationMs } = agg;
  const lines: string[] = [];
  lines.push(`# Link Checker — ${root}`);
  lines.push("");
  lines.push(
    `Recursive link crawl powered by [linkinator](https://github.com/JustinBeckwith/linkinator) — the same engine as \`npx linkinator ${root} --recurse\`.`,
  );
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Pages crawled | ${pagesCrawled} |`);
  lines.push(`| Links checked | ${checked} |`);
  lines.push(`| Broken links | ${broken.length} |`);
  if (skippedCount) lines.push(`| Skipped | ${skippedCount} |`);
  lines.push(`| Duration | ${(durationMs / 1000).toFixed(1)}s |`);
  lines.push(`| Coverage | ${capped ? `partial (${cappedReason(capped)} cap)` : "full sweep"} |`);
  lines.push("");

  if (broken.length === 0) {
    lines.push(`✅ No broken links found.`);
  } else {
    lines.push(`## ${broken.length} broken link${broken.length === 1 ? "" : "s"}`);
    lines.push("");
    lines.push(`| Status | URL | Found on |`);
    lines.push(`| --- | --- | --- |`);
    for (const b of broken.slice(0, MAX_BROKEN_LISTED)) {
      lines.push(`| ${statusLabel(b)} | ${b.url} | ${b.parent ?? "—"} |`);
    }
    if (broken.length > MAX_BROKEN_LISTED) {
      lines.push("");
      lines.push(`… and ${broken.length - MAX_BROKEN_LISTED} more.`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
