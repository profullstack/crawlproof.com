import type { Finding } from "@/lib/audit/types";

export function SectionFindings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">No findings.</p>;
  }
  return (
    <ul className="space-y-2">
      {findings
        .sort((a, b) => a.priority - b.priority)
        .map((f, i) => (
          <FindingRow key={`${f.check_key}-${i}`} f={f} />
        ))}
    </ul>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const cls =
    f.status === "pass"
      ? "badge-pass"
      : f.status === "warn"
        ? "badge-warn"
        : f.status === "fail"
          ? "badge-fail"
          : "badge-unknown";
  return (
    <li className="card p-4">
      <div className="flex items-start gap-3">
        <span className={`badge ${cls} uppercase`}>{f.status}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{f.title}</div>
          {f.detail && (
            <p className="mt-1 whitespace-pre-line text-sm text-[var(--color-muted)]">
              {f.detail}
            </p>
          )}
          {f.evidence && Object.keys(f.evidence).length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-[var(--color-muted)]">
                Evidence
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-[var(--color-bg)] p-3 text-xs">
                {JSON.stringify(f.evidence, null, 2)}
              </pre>
            </details>
          )}
        </div>
        <span className="badge text-xs">P{f.priority}</span>
      </div>
    </li>
  );
}
