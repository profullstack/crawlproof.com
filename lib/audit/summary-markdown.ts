import type { SupabaseClient } from "@supabase/supabase-js";
import { ENGINES, type Engine } from "@/lib/credits";

export type SummaryRow = {
  id: string;
  engine: string;
  status: string;
  score: number | null;
  share_token: string | null;
  summary: { pass?: number; warn?: number; fail?: number } | null;
  report_markdown: string | null;
  failed_reason: string | null;
  created_at: string;
};

// Build the canonical "executive summary + per-engine sections" Markdown
// for a multi-engine scan run. Used by the worker (for the summary PDF
// it attaches to email) and by the report.md / pdf routes when a share
// token belongs to a multi-engine run. Single source of truth so all
// three surfaces stay in sync.
export function buildScanRunMarkdown(input: {
  targetUrl: string;
  rows: SummaryRow[];
}): string {
  const { targetUrl, rows } = input;
  const completed = rows.filter(
    (r) => r.status === "complete" && r.score !== null,
  );
  const avgScore =
    completed.length > 0
      ? Math.round(
          completed.reduce((s, r) => s + (r.score ?? 0), 0) / completed.length,
        )
      : null;

  const host = (() => {
    try { return new URL(targetUrl).hostname; } catch { return targetUrl; }
  })();
  const generated = new Date().toISOString();

  const tableRows = rows
    .map((r) => {
      const meta = ENGINES[r.engine as Engine];
      const label = meta?.label ?? r.engine;
      const scoreCell =
        r.status === "complete" && r.score !== null ? `${r.score}/100` : r.status;
      const p = r.summary?.pass ?? 0;
      const w = r.summary?.warn ?? 0;
      const f = r.summary?.fail ?? 0;
      return `| ${label} | ${scoreCell} | ${p} | ${w} | ${f} |`;
    })
    .join("\n");

  // Cross-engine instruction block. Tells the receiving LLM the doc is
  // a unified TODO list spanning ALL engines below — don't pick one
  // engine's recommendations in isolation, treat the union of findings
  // as the work to do. Only emitted when there's more than one engine
  // (solo runs use the engine's own embedded instructions instead).
  const aiInstructions = rows.length > 1
    ? [
        `<!--`,
        `Instructions for the AI assistant reading this document:`,
        ``,
        `This is a multi-engine Answer Engine Optimization (AEO) audit of`,
        `${targetUrl}. ${rows.length} different LLMs / rule-based engines`,
        `independently audited the same target. Their full reports follow`,
        `below as "## Engine: <name>" sections.`,
        ``,
        `Treat the UNION of every engine's "Recommended Fixes" and`,
        `"Priority To-Do List" as a single TODO list. The engines overlap`,
        `but don't perfectly agree — when two engines flag the same`,
        `issue, that's strong signal; when only one engine flags it,`,
        `still surface it but mention it's a single-source finding.`,
        ``,
        `For each fix:`,
        `  1. Identify the file(s) in the user's repo that render the`,
        `     affected markup, headers, or content.`,
        `  2. Make the smallest change that resolves the issue.`,
        `  3. Show the user a diff before applying.`,
        ``,
        `Suggested order: P1/critical items from any engine first, then`,
        `P2, then P3. Group related fixes into logical commits (e.g.`,
        `"add security headers", "Organization JSON-LD", "AI bot rules`,
        `in robots.txt").`,
        ``,
        `Skip items the user has already addressed.`,
        `-->`,
        ``,
      ].join("\n")
    : "";

  const exec = [
    aiInstructions,
    `# AEO Audit — ${host}`,
    ``,
    `**Target:** ${targetUrl}`,
    ``,
    `**Generated:** ${generated}`,
    ``,
    `**Engines:** ${rows.length}${avgScore !== null ? ` · **Average score:** ${avgScore}/100` : ""}`,
    ``,
    `## Executive Summary`,
    ``,
    `| Engine | Score | Pass | Warn | Fail |`,
    `|---|---:|---:|---:|---:|`,
    tableRows,
    ``,
    avgScore !== null
      ? `Average score: **${avgScore}/100** across ${rows.length} engine${rows.length === 1 ? "" : "s"}.`
      : `${rows.length} engine${rows.length === 1 ? "" : "s"} run.`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const perEngine = rows
    .map((r) => {
      const meta = ENGINES[r.engine as Engine];
      const label = meta?.label ?? r.engine;
      if (r.status === "failed") {
        return [
          `## Engine: ${label}`,
          ``,
          `_Engine failed: ${r.failed_reason ?? "unknown reason"}_`,
          ``,
          `---`,
          ``,
        ].join("\n");
      }
      if (!r.report_markdown) {
        return [`## Engine: ${label}`, ``, `_Report unavailable._`, ``, `---`, ``].join("\n");
      }
      return [
        `## Engine: ${label}`,
        ``,
        r.report_markdown,
        ``,
        `---`,
        ``,
      ].join("\n");
    })
    .join("\n");

  return exec + perEngine;
}

/**
 * Pick the right Markdown to surface for a single audit row: the
 * consolidated multi-engine doc when this audit is part of a run with
 * siblings, otherwise just the audit's own report. Keeps the on-screen
 * Report tab in lockstep with the Download / Copy buttons that already
 * use buildScanRunMarkdown — same input, same output, no surprise diff
 * between what you see and what you grab.
 */
export async function loadConsolidatedOrSoloMarkdown(
  sb: SupabaseClient<any>,
  audit: { scan_run_id: string | null; target_url: string; report_markdown: string | null },
): Promise<string | null> {
  if (!audit.scan_run_id) return audit.report_markdown;
  const { data: siblings } = await sb
    .from("audits")
    .select(
      "id, engine, status, score, share_token, summary, report_markdown, failed_reason, created_at",
    )
    .eq("scan_run_id", audit.scan_run_id)
    .order("created_at", { ascending: true });
  const rows = (siblings ?? []) as SummaryRow[];
  if (rows.length <= 1) return audit.report_markdown;
  return buildScanRunMarkdown({ targetUrl: audit.target_url, rows });
}
