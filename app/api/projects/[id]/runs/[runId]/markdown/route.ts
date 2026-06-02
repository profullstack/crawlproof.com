import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import {
  buildScanRunMarkdown,
  type SummaryRow,
} from "@/lib/audit/summary-markdown";

export const runtime = "nodejs";

// Consolidated Markdown for a scan run — executive summary followed by each
// engine's full report. Used by the Copy Markdown button on the scan-run page.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId);
  if (!access.ok) {
    return new Response(access.error, { status: access.error === "Not authenticated." ? 401 : 404 });
  }

  const { data: audits } = await access.supabase
    .from("audits")
    .select(
      "id, engine, status, score, share_token, summary, report_markdown, failed_reason, created_at, target_url",
    )
    .eq("scan_run_id", runId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const rows = (audits ?? []) as (SummaryRow & { target_url: string })[];
  if (rows.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const md = buildScanRunMarkdown({
    targetUrl: rows[0].target_url,
    rows,
  });
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
