import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { type Engine } from "@/lib/credits";
import { ScanRunResults, type RunAudit } from "@/components/scan-run-results";
import { ScanRunRefresh } from "@/components/scan-run-refresh";
import { PdfButton } from "@/components/pdf-button";
import { CopyMarkdownButton } from "@/components/copy-markdown-button";

export const dynamic = "force-dynamic";

export default async function ScanRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: projectId, runId } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) notFound();

  const { data: audits } = await supabase
    .from("audits")
    .select(
      "id, engine, status, score, share_token, failed_reason, completed_at, summary, created_at, target_url",
    )
    .eq("scan_run_id", runId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  const rows = (audits ?? []) as (RunAudit & { target_url: string })[];
  if (rows.length === 0) notFound();

  const allDone = rows.every(
    (r) => r.status === "complete" || r.status === "failed",
  );
  const typedRows: RunAudit[] = rows.map((r) => ({
    id: r.id,
    engine: r.engine as Engine,
    status: r.status,
    score: r.score,
    share_token: r.share_token,
    failed_reason: r.failed_reason,
    completed_at: r.completed_at,
    created_at: r.created_at,
    summary: r.summary,
  }));

  const anyComplete = typedRows.some((r) => r.status === "complete");

  return (
    <>
      <ScanRunResults
        rows={typedRows}
        targetUrl={rows[0].target_url}
        backHref={`/projects/${projectId}`}
        backLabel={project.name}
        ownerActions={
          anyComplete ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <PdfButton auditId={rows[0].id} />
              <CopyMarkdownButton
                href={`/api/projects/${projectId}/runs/${runId}/markdown`}
              />
            </div>
          ) : undefined
        }
      />
      <ScanRunRefresh projectId={projectId} runId={runId} done={allDone} />
    </>
  );
}
