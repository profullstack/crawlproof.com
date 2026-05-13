import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { ScoreBadge } from "@/components/score-badge";
import type { Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";

type AuditRow = {
  id: string;
  status: string;
  score: number | null;
  created_at: string;
  engine: string;
  scan_run_id: string | null;
};

type RunGroup = {
  runKey: string;
  scanRunId: string | null;
  audits: AuditRow[];
  avgScore: number | null;
  allDone: boolean;
  startedAt: string;
};

function groupByRun(rows: AuditRow[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const a of rows) {
    const key = a.scan_run_id ?? `solo-${a.id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        runKey: key,
        scanRunId: a.scan_run_id,
        audits: [],
        avgScore: null,
        allDone: true,
        startedAt: a.created_at,
      };
      groups.set(key, g);
    }
    g.audits.push(a);
    if (a.created_at < g.startedAt) g.startedAt = a.created_at;
  }
  for (const g of groups.values()) {
    const completed = g.audits.filter(
      (a) => a.status === "complete" && a.score !== null,
    );
    g.avgScore =
      completed.length > 0
        ? Math.round(
            completed.reduce((s, a) => s + (a.score ?? 0), 0) /
              completed.length,
          )
        : null;
    g.allDone = g.audits.every(
      (a) => a.status === "complete" || a.status === "failed",
    );
  }
  return Array.from(groups.values()).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

export default async function ProjectScansPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  const { data: audits } = await supabase
    .from("audits")
    .select("id, status, score, created_at, engine, scan_run_id")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  const rows = (audits ?? []) as AuditRow[];
  const runs = groupByRun(rows);

  return (
    <ProjectShell
      project={{
        id: project.id,
        name: project.name,
        url: project.url,
        schedule: project.schedule,
        status: (project.status ?? "active") as ProjectStatus,
        engines: (project.engines ?? ["rule"]) as Engine[],
      }}
      currentTab="scans"
    >
      {runs.length > 0 ? (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.runKey} className="card p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={
                      run.scanRunId
                        ? `/projects/${project.id}/runs/${run.scanRunId}`
                        : `/audits/${run.audits[0].id}`
                    }
                    className="font-medium hover:underline"
                  >
                    {new Date(run.startedAt).toLocaleString()}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {run.audits.map((a) => (
                      <span
                        key={a.id}
                        className="badge badge-unknown"
                        title={`${a.engine} — ${a.status}${a.score !== null ? ` (${a.score}/100)` : ""}`}
                      >
                        {a.engine}
                        {a.status === "complete" && a.score !== null
                          ? ` ${a.score}`
                          : a.status === "failed"
                            ? " ✗"
                            : ""}
                      </span>
                    ))}
                  </div>
                </div>
                <ScoreBadge
                  score={run.avgScore}
                  status={run.allDone ? "complete" : "running"}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[var(--color-muted)]">
          No scans yet. Pick engines on the Overview tab and click Run now.
        </p>
      )}
    </ProjectShell>
  );
}
