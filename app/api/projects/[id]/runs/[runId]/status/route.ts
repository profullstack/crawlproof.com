import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/projects/<id>/runs/<runId>/status
// Returns every audit in a scan run for the live-polling page.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId);
  if (!access.ok) {
    const status = access.error === "Not authenticated." ? 401 : 404;
    return NextResponse.json({ ok: false, error: access.error }, { status });
  }

  const { data: audits } = await access.supabase
    .from("audits")
    .select(
      "id, engine, status, score, share_token, failed_reason, completed_at, summary, created_at, target_url",
    )
    .eq("scan_run_id", runId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  return NextResponse.json({ ok: true, audits: audits ?? [] });
}
