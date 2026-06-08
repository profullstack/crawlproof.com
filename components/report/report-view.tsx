import { SECTIONS } from "@/lib/audit/prompt";
import { SectionFindings } from "./section";
import { DataFoundTable } from "./data-found";
import type { Finding } from "@/lib/audit/types";

export type AuditRow = {
  id: string;
  target_url: string;
  status: string;
  score: number | null;
  summary: Record<string, unknown>;
  completed_at: string | null;
  created_at: string;
  share_token?: string | null;
  engine?: string | null;
};

interface FixContext {
  projectId: string;
  auditId: string;
  repos: Array<{ full_name: string; installation_id: number }>;
  boundRepos: Array<{ full_name: string; installation_id: number }>;
}

export function ReportView({
  audit,
  findings,
  ownerActions,
  fixContext,
}: {
  audit: AuditRow;
  findings: Finding[];
  ownerActions?: React.ReactNode;
  fixContext?: FixContext;
}) {
  const dataFound = ((audit.summary as { dataFound?: unknown[] })?.dataFound ?? []) as Array<{
    dataPoint: string;
    found: boolean;
    source: string | null;
    notes: string | null;
  }>;
  const sections = reportSections(findings, audit.engine);

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-8">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <details className="card p-4 text-sm lg:!block" open>
          <summary className="cursor-pointer list-none text-xs uppercase tracking-wider text-[var(--color-muted)] lg:cursor-default [&::-webkit-details-marker]:hidden">
            Sections
          </summary>
          <nav className="mt-3 flex flex-col gap-1">
            {sections.map((s, i) => (
              <a key={s} href={`#section-${i + 1}`} className="rounded px-2 py-1 hover:bg-[var(--color-bg)]">
                {i + 1}. {s}
              </a>
            ))}
          </nav>
        </details>
      </aside>

      <article className="space-y-10">
        <header className="card p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                AEO audit
              </p>
              <h1 className="mt-1 text-2xl font-extrabold break-all sm:text-3xl">{audit.target_url}</h1>
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                {audit.completed_at
                  ? `Completed ${new Date(audit.completed_at).toLocaleString()}`
                  : `Started ${new Date(audit.created_at).toLocaleString()}`}
              </p>
            </div>
            <div className="flex items-center gap-3 sm:flex-shrink-0">
              <ScoreDial score={audit.score} status={audit.status} />
              {ownerActions}
            </div>
          </div>
        </header>

        {sections.map((s, i) => {
          const sectionFindings = findings.filter((f) => f.section === s);
          if (s === "Data Found") {
            return (
              <SectionShell key={s} index={i + 1} title={s}>
                <DataFoundTable rows={dataFound} />
              </SectionShell>
            );
          }
          return (
            <SectionShell key={s} index={i + 1} title={s}>
              <SectionFindings
                findings={sectionFindings}
                fixContext={fixContext}
              />
            </SectionShell>
          );
        })}
      </article>
    </div>
  );
}

export function reportSections(findings: Finding[], engine?: string | null): string[] {
  const findingSections = Array.from(
    new Set(findings.map((f) => f.section).filter(Boolean)),
  );
  const compactEngine = engine === "dns" || engine === "links" || engine === "spec";
  if (compactEngine) {
    return findingSections.length > 0 ? findingSections : [...SECTIONS];
  }
  const out = [...SECTIONS];
  for (const section of findingSections) {
    if (!out.includes(section as (typeof SECTIONS)[number])) {
      out.push(section as (typeof SECTIONS)[number]);
    }
  }
  return out;
}

function SectionShell({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={`section-${index}`} className="space-y-3">
      <h2 className="text-xl font-bold">
        <span className="text-[var(--color-muted)]">{index}.</span> {title}
      </h2>
      {children}
    </section>
  );
}

function ScoreDial({ score, status }: { score: number | null; status: string }) {
  if (status !== "complete" || score === null) {
    return <span className="badge badge-unknown">{status}</span>;
  }
  const tone = score >= 80 ? "var(--color-pass)" : score >= 50 ? "var(--color-warn)" : "var(--color-fail)";
  return (
    <div
      className="flex size-20 items-center justify-center rounded-full border-2 text-center"
      style={{ borderColor: tone }}
    >
      <div>
        <div className="text-2xl font-extrabold" style={{ color: tone }}>{score}</div>
        <div className="text-[10px] uppercase text-[var(--color-muted)]">/100</div>
      </div>
    </div>
  );
}
