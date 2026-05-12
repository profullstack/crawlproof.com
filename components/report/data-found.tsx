export function DataFoundTable({
  rows,
}: {
  rows: Array<{
    dataPoint: string;
    found: boolean;
    source: string | null;
    notes: string | null;
  }>;
}) {
  if (rows.length === 0)
    return <p className="text-sm text-[var(--color-muted)]">No data collected yet.</p>;

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase text-[var(--color-muted)]">
            <th className="px-4 py-3">Data Point</th>
            <th className="px-4 py-3">Found?</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.dataPoint} className="border-b border-[var(--color-border)] last:border-0">
              <td className="px-4 py-3 font-medium">{r.dataPoint}</td>
              <td className="px-4 py-3">
                <span className={`badge ${r.found ? "badge-pass" : "badge-warn"}`}>
                  {r.found ? "Yes" : "No"}
                </span>
              </td>
              <td className="px-4 py-3 text-[var(--color-muted)]">{r.source ?? "—"}</td>
              <td className="px-4 py-3 text-[var(--color-muted)]">{r.notes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
