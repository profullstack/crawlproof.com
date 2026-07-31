"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { RANGES, type RangeId } from "@/lib/ads/ranges";

/**
 * Stock-chart style range picker: 1H · 4H · 1D · 1W · 1M · 3M · 1Y · ALL.
 *
 * One row, above everything it scopes — the range governs the header chart, the
 * header stats and the per-campaign figures alike, so the numbers on the page
 * always agree with each other.
 *
 * State lives in the URL rather than in component state so a range survives a
 * refresh and can be linked to. Navigation runs in a transition and the
 * surrounding content keeps its last render at reduced opacity while the server
 * re-renders — no skeleton and no layout jump between ranges.
 */
export function RangeTabs({ value }: { value: RangeId }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function select(id: RangeId) {
    if (id === value) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", id);
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }));
  }

  return (
    <div
      role="tablist"
      aria-label="Time range"
      data-pending={pending ? "" : undefined}
      className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] p-0.5"
    >
      {RANGES.map((r) => {
        const selected = r.id === value;
        return (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={selected}
            title={r.hint}
            onClick={() => select(r.id)}
            className={[
              "rounded-md px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors",
              selected
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "text-[var(--color-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-fg)]",
            ].join(" ")}
          >
            {r.label}
            <span className="sr-only"> — {r.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
