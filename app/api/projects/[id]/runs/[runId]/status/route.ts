import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/projects/<id>/runs/<runId>/status
// Returns every audit in a scan run for the live-polling page. Owner-gated.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const { id: projectId, runId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const { data: audits } = await supabase
    .from("audits")
    .select(
      "id, engine, status, score, share_token, failed_reason, completed_at, summary, created_at, target_url",
    )
    .eq("scan_run_id", runId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  return NextResponse.json({ ok: true, audits: audits ?? [] });
}
