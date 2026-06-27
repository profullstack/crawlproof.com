import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { EnginesPanel } from "@/components/engines-panel";
import { AeoScoreTrend } from "@/components/aeo-score-trend";
import { ProjectShell } from "@/components/project-shell";
import { DeleteProjectButton } from "./delete-project-button";
import { EditUrlForm } from "./edit-url-form";
import { ScoreBadge } from "@/components/score-badge";
import { DEFAULT_PROJECT_ENGINES, ENGINES, type Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";

type AuditRow = {
  id: string;
  status: string;
  score: number | null;
  created_at: string;
  engine: string;
  scan_run_id: string | null;
};

type SectionSummary = {
  section: string;
  pass: number;
  warn: number;
  fail: number;
  unknown: number;
  engines: string[];
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
  const latestRunEngineByAuditId = new Map(
    latestRunAudits.map((a) => [a.id, a.engine]),
  );
  const latestRunAuditIds = latestRunAudits.map((a) => a.id);
  let latestRunSections: SectionSummary[] = [];
  if (latestRunAuditIds.length > 0) {
    const { data: latestFindings } = await supabase
      .from("audit_findings")
      .select("audit_id, section, status")
      .in("audit_id", latestRunAuditIds);
    const bySection = new Map<
      string,
      Omit<SectionSummary, "engines"> & { engines: Set<string> }
    >();
    for (const f of latestFindings ?? []) {
      const section = (f.section as string | null) ?? "Other";
      const row =
        bySection.get(section) ??
        {
          section,
          pass: 0,
          warn: 0,
          fail: 0,
          unknown: 0,
          engines: new Set<string>(),
        };
      const status = f.status as "pass" | "warn" | "fail" | "unknown";
      if (status === "pass") row.pass++;
      else if (status === "warn") row.warn++;
      else if (status === "fail") row.fail++;
      else row.unknown++;
      const engine = latestRunEngineByAuditId.get(f.audit_id as string);
      if (engine) row.engines.add(engine);
      bySection.set(section, row);
    }
    latestRunSections = Array.from(bySection.values())
      .map((row) => ({
        ...row,
        engines: Array.from(row.engines),
      }))
      .sort(
        (a, b) =>
          b.fail - a.fail ||
          b.warn - a.warn ||
          a.section.localeCompare(b.section),
      );
  }

  return (
    <ProjectShell
      project={{
        id: project.id,
        name: project.name,
        url: project.url,
        schedule: project.schedule,
        status: (project.status ?? "active") as ProjectStatus,
        engines: (project.engines ?? DEFAULT_PROJECT_ENGINES) as Engine[],
        logo_url: (project as { logo_url?: string | null }).logo_url ?? null,
      }}
      currentTab="overview"
    >
      <div className="space-y-6">
        <EnginesPanel
          projectId={project.id}
          url={project.url}
          defaultEngines={(project.engines ?? DEFAULT_PROJECT_ENGINES) as Engine[]}
        />

        <AeoScoreTrend projectId={project.id} />

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
                    {ENGINES[a.engine as Engine]?.label ?? a.engine}
                  </Link>
                  <ScoreBadge score={a.score} status={a.status} />
                </li>
              ))}
            </ul>
            {latestRunSections.length > 0 && (
              <div className="mt-5 border-t border-[var(--color-border)] pt-4">
                <h3 className="text-sm font-semibold">
                  Latest run analytics sections
                </h3>
                <div className="mt-3 grid gap-2">
                  {latestRunSections.map((section) => (
                    <div
                      key={section.section}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium">{section.section}</div>
                        <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                          <Count label="pass" value={section.pass} tone="pass" />
                          <Count label="warn" value={section.warn} tone="warn" />
                          <Count label="fail" value={section.fail} tone="fail" />
                          {section.unknown > 0 && (
                            <span>{section.unknown} unknown</span>
                          )}
                        </div>
                      </div>
                      {section.engines.length > 0 && (
                        <div className="mt-1 text-xs text-[var(--color-muted)]">
                          {section.engines
                            .map((engine) => ENGINES[engine as Engine]?.label ?? engine)
                            .join(", ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
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

        {/* Site URL — fix a domain typo without recreating the project. */}
        <section className="card p-4">
          <h2 className="text-lg font-semibold">Site URL</h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            The domain this project audits. Editing it also re-points any
            connected autoblog config.
          </p>
          <p className="mt-2 break-all text-sm">{project.url}</p>
          <div className="mt-3">
            <EditUrlForm
              projectId={project.id}
              initialUrl={project.url}
              initialName={project.name}
            />
          </div>
        </section>

        {/* Danger zone */}
        <section className="border-t border-[var(--color-border)] pt-4">
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Danger zone
          </h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Deletes the project and everything attached to it: audits,
            autoblog config, queued keywords, article history, and
            social-binding overrides. Connected social accounts (which
            are global per-user) are NOT deleted.
          </p>
          <div className="mt-2">
            <DeleteProjectButton projectId={project.id} />
          </div>
        </section>
      </div>
    </ProjectShell>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "pass" | "warn" | "fail";
}) {
  const color =
    tone === "pass"
      ? "var(--color-pass)"
      : tone === "warn"
        ? "var(--color-warn)"
        : "var(--color-fail)";
  return (
    <span>
      <span className="font-semibold" style={{ color }}>
        {value}
      </span>{" "}
      {label}
    </span>
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
