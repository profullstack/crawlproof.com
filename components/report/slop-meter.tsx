import type { Finding } from "@/lib/audit/types";

// The shareable headline of a Slop Score scan.
//
// Form choice: the score is a single number, so it's a hero stat — not a chart.
// The per-dimension breakdown is three magnitudes of the SAME measure (slop
// points), so it gets one neutral hue with identity carried by the text labels;
// the status tokens stay reserved for the score's own state, paired with the
// grade word so state is never conveyed by color alone.

type SlopEvidence = {
  score?: number;
  grade?: string;
  byDimension?: { content?: number; code?: number; design?: number };
  totals?: { pages?: number; issues?: number; words?: number };
};

const DIMENSIONS = [
  { key: "content", label: "Content", hint: "filler, thin pages, duplicates, stale dates" },
  { key: "code", label: "Code", hint: "leaked template vars, dev URLs, dead links" },
  { key: "design", label: "Design", hint: "viewport, alt text, layout shift, style drift" },
] as const;

export function SlopMeter({ findings }: { findings: Finding[] }) {
  const headline = findings.find((f) => f.check_key === "slop.score");
  const ev = (headline?.evidence ?? {}) as SlopEvidence;
  const score = typeof ev.score === "number" ? ev.score : null;
  if (score === null) return null;

  const grade = ev.grade ?? "";
  const dims = ev.byDimension ?? {};
  const totals = ev.totals ?? {};
  // Lower is better here, which inverts the usual AEO dial.
  const tone =
    score <= 25 ? "var(--color-pass)" : score <= 50 ? "var(--color-warn)" : "var(--color-fail)";
  const max = Math.max(1, ...DIMENSIONS.map((d) => dims[d.key] ?? 0));

  return (
    <div className="card space-y-5 p-4 sm:p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
        <div className="sm:flex-shrink-0">
          <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Slop Score</p>
          <p className="mt-1 flex items-baseline gap-1.5">
            <span className="text-5xl font-extrabold leading-none" style={{ color: tone }}>
              {score}
            </span>
            <span className="text-sm text-[var(--color-muted)]">/ 100</span>
          </p>
          <p className="mt-1.5 text-sm font-semibold" style={{ color: tone }}>
            {grade}
          </p>
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          {/* Track runs low→high slop so the filled portion reads as "how much
              slop", matching the number above it. */}
          <div
            className="h-2 w-full overflow-hidden rounded-full"
            style={{ background: "var(--color-border)" }}
            role="img"
            aria-label={`Slop score ${score} out of 100 — ${grade}`}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, score)}%`, background: tone }}
            />
          </div>
          <div className="flex justify-between text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            <span>0 — pristine</span>
            <span>100 — maximum slop</span>
          </div>
          <p className="text-sm text-[var(--color-muted)]">
            {[
              typeof totals.pages === "number"
                ? `${totals.pages} page${totals.pages === 1 ? "" : "s"} swept`
                : null,
              typeof totals.words === "number" ? `${totals.words.toLocaleString()} words` : null,
              typeof totals.issues === "number"
                ? `${totals.issues} issue${totals.issues === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>

      <div className="space-y-2.5 border-t border-[var(--color-border)] pt-4">
        <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Slop points by dimension
        </p>
        {DIMENSIONS.map((d) => {
          const v = dims[d.key] ?? 0;
          return (
            <div key={d.key} className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-3 text-sm">
              <span className="font-medium">{d.label}</span>
              <span className="h-1.5 w-full rounded-full" style={{ background: "var(--color-border)" }}>
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${v === 0 ? 0 : Math.max(3, (v / max) * 100)}%`,
                    background: "var(--color-accent)",
                  }}
                />
              </span>
              <span className="text-right tabular-nums text-[var(--color-muted)]">{v}</span>
              <span className="col-span-3 -mt-1.5 text-xs text-[var(--color-muted)]">{d.hint}</span>
            </div>
          );
        })}
      </div>

      <p className="border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-muted)]">
        This measures <strong>observable defects</strong> — placeholder copy, near-duplicate pages,
        leaked template variables, missing first-party evidence, stale dates, design drift. It does
        not estimate whether anything was written by AI.
      </p>
    </div>
  );
}
