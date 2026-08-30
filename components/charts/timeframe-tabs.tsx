"use client";

import { useRef } from "react";
import type { TrackerRange, TrackerRangeKey } from "@/lib/tracker/ranges";

// The tab strip that sits in each stats card header. Presentational — the
// owning panel holds the selected range and does the fetching.
export function TimeframeTabs({
  ranges,
  value,
  onChange,
  disabled = false,
  label = "Timeframe",
}: {
  ranges: TrackerRange[];
  value: TrackerRangeKey;
  onChange: (key: TrackerRangeKey) => void;
  disabled?: boolean;
  label?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving arrow-key focus: a tablist that only responds to clicks strands
  // keyboard users on whichever tab happens to be selected.
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + ranges.length) % ranges.length;
    refs.current[next]?.focus();
    onChange(ranges[next].key);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className="inline-flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5"
    >
      {ranges.map((range, index) => {
        const selected = range.key === value;
        return (
          <button
            key={range.key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={range.description}
            disabled={disabled}
            onClick={() => onChange(range.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={[
              "rounded px-2 py-0.5 text-xs font-medium tabular-nums transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:text-[var(--color-fg)]",
            ].join(" ")}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}
