import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ScoreBadge } from "@/components/score-badge";
import { EnginesPanel } from "@/components/engines-panel";
import { ScheduleToggle } from "@/components/schedule-toggle";
import type { Engine } from "@/lib/credits";
import { ScoreTrend } from "@/components/charts/score-trend";
import { StatusPie } from "@/components/charts/status-pie";
import { SectionBar, type SectionRow } from "@/components/charts/section-bar";
import { PriorityBar } from "@/components/charts/priority-bar";

type AuditRow = {
  id: string;
  target_url: string;
  status: string;
  score: number | null;
  summary: { pass?: number; warn?: number; fail?: number; unknown?: number } | null;
  created_at: string;
  engine: string;
  scan_run_id: string | null;
};

export default async function ProjectPage({
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
    .select("id,target_url,status,score,summary,created_at,engine,scan_run_id")
    .eq("project_id", id)
    .order("created_at", { ascending: false });

  const completed = ((audits ?? []) as AuditRow[]).filter(
    (a) => a.status === "complete" && a.score !== null,
  );
  const last = completed[0];
  const prev = completed[1];

  // Score trend (oldest -> newest for the line chart)
  const trend = [...completed]
    .reverse()
    .map((a) => ({ date: a.created_at, score: a.score! }));

  // Latest run status counts
  const statusCounts = {
    pass: last?.summary?.pass ?? 0,
    warn: last?.summary?.warn ?? 0,
    fail: last?.summary?.fail ?? 0,
    unknown: last?.summary?.unknown ?? 0,
  };

  // Section breakdown + priority distribution from the most recent run.
  let sectionRows: SectionRow[] = [];
  const priorityCounts = { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0 };
  if (last) {
    const { data: findings } = await supabase
      .from("audit_findings")
      .select("section,status,priority")
      .eq("audit_id", last.id);
    const map = new Map<string, SectionRow>();
    for (const f of findings ?? []) {
      const row =
        map.get(f.section as string) ??
        { section: f.section as string, pass: 0, warn: 0, fail: 0 };
      const s = f.status as "pass" | "warn" | "fail" | "unknown";
      if (s === "pass") row.pass++;
      else if (s === "warn") row.warn++;
      else if (s === "fail") row.fail++;
      map.set(f.section as string, row);
      if (s !== "pass") {
        const p = Math.min(5, Math.max(1, (f.priority as number) ?? 3));
        priorityCounts[`p${p}` as keyof typeof priorityCounts]++;
      }
    }
    sectionRows = Array.from(map.values());
  }

  const trendDelta =
    last && prev && last.score !== null && prev.score !== null
      ? last.score - prev.score
      : null;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{project.name}</h1>
        <p className="mt-1 break-all text-[var(--color-muted)]">{project.url}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ScheduleToggle projectId={project.id} current={project.schedule} />
        {last && prev && (
          <Link href={`/audits/${last.id}?diff=${prev.id}`} className="btn">
            Diff vs previous
          </Link>
        )}
      </div>

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
        <Metric label="Total runs" value={String(completed.length)} tone="muted" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ScoreTrend data={trend} />
        <StatusPie counts={statusCounts} />
        <SectionBar rows={sectionRows} />
        <PriorityBar counts={priorityCounts} />
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Scan history</h2>
        {audits && audits.length > 0 ? (
          <ul className="space-y-2">
            {groupByRun(audits as AuditRow[]).map((run) => (
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
                      {new Date(run.audits[0].created_at).toLocaleString()}
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
          <p className="text-[var(--color-muted)]">No audits yet. Run one above.</p>
        )}
      </section>
    </div>
  );
}

type RunGroup = {
  runKey: string;
  scanRunId: string | null;
  audits: AuditRow[];
  avgScore: number | null;
  allDone: boolean;
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
      };
      groups.set(key, g);
    }
    g.audits.push(a);
  }
  for (const g of groups.values()) {
    const completed = g.audits.filter((a) => a.status === "complete" && a.score !== null);
    g.avgScore =
      completed.length > 0
        ? Math.round(completed.reduce((s, a) => s + (a.score ?? 0), 0) / completed.length)
        : null;
    g.allDone = g.audits.every((a) => a.status === "complete" || a.status === "failed");
  }
  return Array.from(groups.values());
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
