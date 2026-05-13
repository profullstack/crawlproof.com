import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildScanRunMarkdown,
  type SummaryRow,
} from "@/lib/audit/summary-markdown";

export const runtime = "nodejs";

// Owner-only consolidated Markdown for a scan run — executive summary
// followed by each engine's full report. Used by the Copy Markdown
// button on the scan-run page; safe to paste into another LLM.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id: projectId, runId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not authenticated", { status: 401 });

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return new Response("Not found", { status: 404 });
  }

  const { data: audits } = await supabase
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
