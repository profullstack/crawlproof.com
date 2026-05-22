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

  const exec = [
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
