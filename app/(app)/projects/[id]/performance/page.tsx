import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectShell } from "@/components/project-shell";
import { ScoreTrend, type TrendPoint } from "@/components/charts/score-trend";
import { EngineTrend, type EngineTrendPoint } from "@/components/charts/engine-trend";
import { StatusPie } from "@/components/charts/status-pie";
import { SectionBar, type SectionRow } from "@/components/charts/section-bar";
import { PriorityBar } from "@/components/charts/priority-bar";
import type { Engine } from "@/lib/credits";
import type { ProjectStatus } from "@/app/actions/projects";

type AuditRow = {
  id: string;
  status: string;
  score: number | null;
  summary: { pass?: number; warn?: number; fail?: number; unknown?: number } | null;
  created_at: string;
  engine: Engine;
  scan_run_id: string | null;
};

export default async function ProjectPerformancePage({
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
    .select("id, status, score, summary, created_at, engine, scan_run_id")
    .eq("project_id", id)
    .order("created_at", { ascending: true });

  const rows = (audits ?? []) as AuditRow[];
  const completed = rows.filter((a) => a.status === "complete" && a.score !== null);

  // Group completed audits by scan_run_id so each timeline point represents
  // ONE multi-engine click. The overall trend averages across engines in
  // that run; the per-engine trend keeps each engine on its own line.
  const runs = new Map<
    string,
    {
      date: string;
      byEngine: Partial<Record<Engine, number>>;
      avg: number | null;
    }
  >();
  for (const a of completed) {
    const key = a.scan_run_id ?? `solo-${a.id}`;
    const r =
      runs.get(key) ?? { date: a.created_at, byEngine: {}, avg: null };
    r.byEngine[a.engine] = a.score!;
    if (a.created_at < r.date) r.date = a.created_at;
    runs.set(key, r);
  }
  const runArr = Array.from(runs.values())
    .map((r) => {
      const vals = Object.values(r.byEngine).filter((v): v is number => v !== undefined);
      r.avg =
        vals.length > 0
          ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)
          : null;
      return r;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const overallTrend: TrendPoint[] = runArr
    .filter((r) => r.avg !== null)
    .map((r) => ({ date: r.date, score: r.avg! }));

  const engineTrend: EngineTrendPoint[] = runArr.map((r) => ({
    date: r.date,
    ...r.byEngine,
  }));

  const enginesSeen = Array.from(
    new Set(completed.map((a) => a.engine)),
  ) as Engine[];

  // Latest run breakdowns — pie + section + priority bars off the most
  // recently completed audit (any engine).
  const last = [...completed].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )[0];
  const statusCounts = {
    pass: last?.summary?.pass ?? 0,
    warn: last?.summary?.warn ?? 0,
    fail: last?.summary?.fail ?? 0,
    unknown: last?.summary?.unknown ?? 0,
  };
  let sectionRows: SectionRow[] = [];
  const priorityCounts = { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0 };
  if (last) {
    const { data: findings } = await supabase
      .from("audit_findings")
      .select("section, status, priority")
      .eq("audit_id", last.id);
    const map = new Map<string, SectionRow>();
    for (const f of findings ?? []) {
      const row = map.get(f.section as string) ?? {
        section: f.section as string,
        pass: 0,
        warn: 0,
        fail: 0,
      };
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

  return (
    <ProjectShell
      project={{
        id: project.id,
        name: project.name,
        url: project.url,
        schedule: project.schedule,
        status: (project.status ?? "active") as ProjectStatus,
        engines: (project.engines ?? ["rule"]) as Engine[],
        logo_url: (project as { logo_url?: string | null }).logo_url ?? null,
      }}
      currentTab="performance"
    >
      <div className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Score over time</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <ScoreTrend data={overallTrend} />
            <EngineTrend data={engineTrend} engines={enginesSeen} />
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            Latest run breakdown
            {last && (
              <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                {new Date(last.created_at).toLocaleString()} · {last.engine}
              </span>
            )}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <StatusPie counts={statusCounts} />
            <PriorityBar counts={priorityCounts} />
            <div className="lg:col-span-2">
              <SectionBar rows={sectionRows} />
            </div>
          </div>
        </section>
      </div>
    </ProjectShell>
  );
}
