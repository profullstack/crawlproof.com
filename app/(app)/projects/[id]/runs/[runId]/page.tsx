import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ENGINES, type Engine } from "@/lib/credits";
import { ScanRunPoller } from "@/components/scan-run-poller";

export const dynamic = "force-dynamic";

type RunAudit = {
  id: string;
  engine: Engine;
  status: string;
  score: number | null;
  share_token: string | null;
  failed_reason: string | null;
  completed_at: string | null;
  created_at: string;
  summary: { pass?: number; warn?: number; fail?: number } | null;
};

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

  const first = rows[0];
  const allTerminal = rows.every(
    (r) => r.status === "complete" || r.status === "failed",
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="text-sm text-[var(--color-muted)]"
        >
          ← {project.name}
        </Link>
        <h1 className="mt-3 text-2xl font-bold">Scan run</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {new Date(first.created_at).toLocaleString()} ·{" "}
          <span className="break-all">{first.target_url}</span>
        </p>
      </div>

      <ScanRunPoller
        projectId={projectId}
        runId={runId}
        initial={rows}
        initialAllDone={allTerminal}
      />
    </div>
  );
}
