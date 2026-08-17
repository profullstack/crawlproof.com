// Link-checker engine — recursively crawls the target's root domain with
// linkinator (the same crawler as `npx linkinator <url> --recurse`) and turns
// the broken-link report into structured findings. Free; no LLM required.
//
// The crawl itself runs in a forked child process (links-crawl-child.ts) because
// linkinator can hard-exit the process it runs in; see links-crawl.ts for the
// mechanism. Everything here — scoring, findings, markdown — runs in the worker
// off the child's JSON report.

import { fork } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { LinkState } from "linkinator";
import { scoreFindings } from "./score";
import type { AuditResult, Finding } from "./types";
import {
  DEADLINE_MS,
  MAX_LINKS,
  MAX_PAGES,
  checkedCount,
  rootOf,
  type Capped,
  type CrawlAccumulator,
  type CrawlLink,
} from "./links-crawl";
import type { ChildReport } from "./links-crawl-child";

type LinksAuditResult = AuditResult & { markdown: string };

// How many broken links to enumerate in findings / markdown before truncating.
const MAX_BROKEN_LISTED = 50;

// The child bounds itself at DEADLINE_MS; this is the backstop for a child that
// wedges instead of finishing, kept under the 7-minute stuck-audit cutoff.
const CHILD_KILL_AFTER_MS = DEADLINE_MS + 60_000;

/** Resolve the child entry next to this module, matching its extension so the
 * same code works under tsx (.ts, as start.sh runs it) and compiled (.js). */
function childEntryPath(): string {
  const self = new URL(import.meta.url);
  return fileURLToPath(new URL(`./links-crawl-child${extname(self.pathname)}`, self));
}

/**
 * fork() inherits execArgv, so under the worker's `tsx worker/index.ts` the
 * child already gets tsx's loader. Add it explicitly when the parent runtime
 * transforms TypeScript some other way (vitest) and the child would otherwise
 * hit a plain `node` that can't read .ts.
 */
function childExecArgv(entry: string): string[] {
  const inherited = process.execArgv;
  if (!entry.endsWith(".ts")) return inherited;
  if (inherited.some((a) => a.includes("tsx"))) return inherited;
  return [...inherited, "--import", "tsx"];
}

type ChildOutcome =
  | { ok: true; acc: CrawlAccumulator; crashed: string | null }
  | { ok: false; error: string };

/**
 * Run the crawl in a child process. Never throws: a child that dies, times out
 * or emits garbage becomes { ok: false } for the caller to report.
 */
async function runCrawlChild(
  targetUrl: string,
  perLinkTimeoutMs?: number,
): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    let child: ReturnType<typeof fork>;
    try {
      const entry = childEntryPath();
      const args = [targetUrl];
      if (perLinkTimeoutMs) args.push(String(perLinkTimeoutMs));
      child = fork(entry, args, {
        execArgv: childExecArgv(entry),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (err) {
      resolve({ ok: false, error: `could not start crawl process: ${messageOf(err)}` });
      return;
    }

    let stdout = "";
    let settled = false;
    const done = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(outcome);
    };

    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      done({
        ok: false,
        error: `crawl process exceeded ${Math.round(CHILD_KILL_AFTER_MS / 60_000)} minutes and was killed`,
      });
    }, CHILD_KILL_AFTER_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // Surface the child's diagnostics in the worker log rather than dropping them.
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      done({ ok: false, error: `crawl process error: ${messageOf(err)}` });
    });
    child.on("close", (code, signal) => {
      if (!stdout.trim()) {
        done({
          ok: false,
          error: `crawl process exited without a report (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        });
        return;
      }
      try {
        const report = JSON.parse(stdout) as ChildReport;
        done({ ok: true, acc: report.acc, crashed: report.crashed ?? null });
      } catch (err) {
        done({ ok: false, error: `unreadable crawl report: ${messageOf(err)}` });
      }
    });
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function linksAudit(
  targetUrl: string,
  // Test seam: shortens the per-link abort so the mid-body race is deterministic.
  opts: { perLinkTimeoutMs?: number } = {},
): Promise<LinksAuditResult> {
  const started = Date.now();
  const root = rootOf(targetUrl);

  const outcome = await runCrawlChild(targetUrl, opts.perLinkTimeoutMs);

  if (!outcome.ok) {
    const findings: Finding[] = [
      {
        section: "Links & Images",
        check_key: "links.crawl_error",
        status: "fail",
        title: "Link crawl could not complete",
        detail: `linkinator failed to crawl ${root}: ${outcome.error}`,
        priority: 1,
      },
    ];
    return {
      score: scoreFindings(findings),
      findings,
      markdown: `# Link Checker — ${root}\n\nThe crawl could not be completed: ${outcome.error}\n`,
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

  const acc: CrawlAccumulator = {
    pagesCrawled: outcome.acc?.pagesCrawled ?? 0,
    capped: outcome.acc?.capped ?? null,
    links: outcome.acc?.links ?? [],
  };
  const checked = checkedCount(acc);
  const broken = acc.links.filter((l) => l.state === LinkState.BROKEN);
  const skippedCount = acc.links.filter((l) => l.state === LinkState.SKIPPED).length;

  const agg: Agg = {
    root,
    pagesCrawled: acc.pagesCrawled,
    checked,
    broken,
    skippedCount,
    capped: acc.capped,
    crashed: outcome.crashed,
  };

  const findings = buildFindings(agg);

  return {
    score: scoreFindings(findings),
    findings,
    markdown: buildMarkdown({ ...agg, durationMs: Date.now() - started }),
    summary: {
      pagesCrawled: acc.pagesCrawled,
      pass: findings.filter((f) => f.status === "pass").length,
      warn: findings.filter((f) => f.status === "warn").length,
      fail: findings.filter((f) => f.status === "fail").length,
      unknown: findings.filter((f) => f.status === "unknown").length,
      dataFound: [],
      durationMs: Date.now() - started,
    },
  };
}

function statusLabel(l: CrawlLink): string {
  if (l.status && l.status > 0) return String(l.status);
  return "no response";
}

type Agg = {
  root: string;
  pagesCrawled: number;
  checked: number;
  broken: CrawlLink[];
  skippedCount: number;
  capped: Capped;
  crashed: string | null;
};

function buildFindings(agg: Agg): Finding[] {
  const { root, pagesCrawled, checked, broken, skippedCount, capped, crashed } = agg;
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
  const partial = capped !== null || crashed !== null;
  out.push({
    section: "Links & Images",
    check_key: "links.crawl_coverage",
    status: partial ? "warn" : "pass",
    title: capped
      ? `Crawl capped at ${pagesCrawled} pages (${cappedReason(capped)})`
      : crashed
        ? `Partial crawl — ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} before the crawler stopped`
        : `Crawled ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"}, ${checked} link${checked === 1 ? "" : "s"}`,
    detail: capped
      ? `The recursive crawl hit the ${cappedReason(capped)} budget and stopped early, so links beyond that point were not checked. Re-run on a narrower section, or treat this as a partial sweep.`
      : crashed
        ? `The crawl of ${root} ended before completing, so this covers only ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} and ${checked} link${checked === 1 ? "" : "s"}. Treat it as a partial sweep.`
        : `Full recursive sweep of ${root}: ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} crawled, ${checked} link${checked === 1 ? "" : "s"} checked${skippedCount ? `, ${skippedCount} skipped` : ""}.`,
    evidence: {
      capped: capped ?? false,
      incomplete: crashed !== null,
      pagesCrawled,
      linksChecked: checked,
      skipped: skippedCount,
    },
    priority: 5,
  });

  // The crawler died partway through. We still report what it found, but the
  // reader needs to know the sweep is incomplete.
  if (crashed) {
    out.push({
      section: "Links & Images",
      check_key: "links.crawl_incomplete",
      status: "warn",
      title: "Link crawl ended early",
      detail: `The crawler stopped before finishing (${crashed}). The ${pagesCrawled} page${pagesCrawled === 1 ? "" : "s"} and ${checked} link${checked === 1 ? "" : "s"} below were checked; anything past that point was not. Re-run to sweep the rest.`,
      evidence: { reason: crashed, pagesCrawled, linksChecked: checked },
      priority: 3,
    });
  }

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
  const { root, pagesCrawled, checked, broken, skippedCount, capped, crashed, durationMs } = agg;
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
  lines.push(
    `| Coverage | ${crashed ? "partial (crawl ended early)" : capped ? `partial (${cappedReason(capped)} cap)` : "full sweep"} |`,
  );
  lines.push("");

  if (crashed) {
    lines.push(`> ⚠️ The crawl ended early (${crashed}), so this is a partial sweep.`);
    lines.push("");
  }

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
