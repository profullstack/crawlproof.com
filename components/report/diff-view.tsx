import type { Finding } from "@/lib/audit/types";
import type { AuditRow } from "./report-view";

export function DiffView({
  current,
  previous,
}: {
  current: { audit: AuditRow; findings: Finding[] };
  previous: { audit: AuditRow; findings: Finding[] };
}) {
  const byKeyCur = new Map(current.findings.map((f) => [f.check_key, f]));
  const byKeyPrev = new Map(previous.findings.map((f) => [f.check_key, f]));

  const fixed: Finding[] = [];
  const regressed: Finding[] = [];
  const newIssues: Finding[] = [];

  for (const [key, cur] of byKeyCur) {
    const prev = byKeyPrev.get(key);
    if (!prev) {
      if (cur.status === "fail" || cur.status === "warn") newIssues.push(cur);
      continue;
    }
    if (prev.status !== "pass" && cur.status === "pass") fixed.push(cur);
    else if (prev.status === "pass" && cur.status !== "pass") regressed.push(cur);
  }

  return (
    <div className="space-y-6">
      <header className="card p-5">
        <div className="text-xs uppercase text-[var(--color-muted)]">Audit comparison</div>
        <h1 className="mt-1 text-2xl font-bold">
          {current.audit.target_url}
        </h1>
        <div className="mt-2 flex items-center gap-6 text-sm">
          <div>
            <div className="text-[var(--color-muted)]">Previous</div>
            <div className="text-lg font-bold">{previous.audit.score ?? "—"}</div>
            <div className="text-xs text-[var(--color-muted)]">
              {previous.audit.completed_at &&
                new Date(previous.audit.completed_at).toLocaleString()}
            </div>
          </div>
          <div className="text-2xl text-[var(--color-muted)]">→</div>
          <div>
            <div className="text-[var(--color-muted)]">Current</div>
            <div className="text-lg font-bold">{current.audit.score ?? "—"}</div>
            <div className="text-xs text-[var(--color-muted)]">
              {current.audit.completed_at &&
                new Date(current.audit.completed_at).toLocaleString()}
            </div>
          </div>
        </div>
      </header>

      <Group title={`Fixed (${fixed.length})`} tone="badge-pass" findings={fixed} />
      <Group title={`Regressed (${regressed.length})`} tone="badge-fail" findings={regressed} />
      <Group title={`New issues (${newIssues.length})`} tone="badge-warn" findings={newIssues} />
    </div>
  );
}

function Group({
  title,
  tone,
  findings,
}: {
  title: string;
  tone: string;
  findings: Finding[];
}) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      {findings.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No changes.</p>
      ) : (
        <ul className="space-y-2">
          {findings.map((f) => (
            <li key={f.check_key} className="card p-4">
              <div className="flex items-start gap-3">
                <span className={`badge ${tone}`}>{f.status}</span>
                <div>
                  <div className="font-semibold">{f.title}</div>
                  <div className="text-sm text-[var(--color-muted)]">{f.section}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
