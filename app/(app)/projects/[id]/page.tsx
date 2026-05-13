import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EnginesPanel } from "@/components/engines-panel";
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

export default async function ProjectOverviewPage({
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
    .order("created_at", { ascending: false })
    .limit(50);

  const rows = (audits ?? []) as AuditRow[];
  const completed = rows.filter((a) => a.status === "complete" && a.score !== null);
  const last = completed[0];
  const prev = completed[1];

  const trendDelta =
    last && prev && last.score !== null && prev.score !== null
      ? last.score - prev.score
      : null;

  // Group the most recent scan run for the "latest run" card. Falls back
  // to the solo audit when scan_run_id is null.
  const latestRunId = rows[0]?.scan_run_id ?? null;
  const latestRunAudits = latestRunId
    ? rows.filter((a) => a.scan_run_id === latestRunId)
    : rows.slice(0, 1);

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
      currentTab="overview"
    >
      <div className="space-y-6">
        <EnginesPanel
          projectId={project.id}
          url={project.url}
          defaultEngines={(project.engines ?? ["rule"]) as Engine[]}
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <Metric
            label="Current score"
            value={last ? `${last.score}` : "—"}
            tone={
              last && last.score! >= 80
                ? "pass"
                : last && last.score! >= 50
                  ? "warn"
                  : last
                    ? "fail"
                    : "muted"
            }
          />
          <Metric
            label="Δ vs previous"
            value={
              trendDelta === null
                ? "—"
                : `${trendDelta > 0 ? "+" : ""}${trendDelta}`
            }
            tone={
              trendDelta === null
                ? "muted"
                : trendDelta > 0
                  ? "pass"
                  : trendDelta < 0
                    ? "fail"
                    : "muted"
            }
          />
          <Metric
            label="Total runs"
            value={String(completed.length)}
            tone="muted"
          />
        </div>

        {latestRunAudits.length > 0 && (
          <section className="card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">Latest run</h2>
              <p className="text-xs text-[var(--color-muted)]">
                {new Date(latestRunAudits[0].created_at).toLocaleString()}
              </p>
            </div>
            {last && (
              <Link
                href={`/audits/${last.id}`}
                className="btn btn-primary mt-3 inline-flex"
              >
                View latest report →
              </Link>
            )}
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {latestRunAudits.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                >
                  <Link
                    href={`/audits/${a.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {a.engine}
                  </Link>
                  <ScoreBadge score={a.score} status={a.status} />
                </li>
              ))}
            </ul>
            {latestRunId && (
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <Link
                  href={`/projects/${project.id}/runs/${latestRunId}`}
                  className="text-[var(--color-accent)] hover:underline"
                >
                  Open multi-engine scan run →
                </Link>
                {last && prev && (
                  <Link
                    href={`/audits/${last.id}?diff=${prev.id}`}
                    className="text-[var(--color-muted)] hover:underline"
                  >
                    Diff vs previous run
                  </Link>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </ProjectShell>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "pass" | "warn" | "fail" | "muted";
}) {
  const color =
    tone === "pass"
      ? "var(--color-pass)"
      : tone === "warn"
        ? "var(--color-warn)"
        : tone === "fail"
          ? "var(--color-fail)"
          : "var(--color-fg)";
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-1 text-3xl font-extrabold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
