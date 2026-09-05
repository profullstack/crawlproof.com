"use client";

import { useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DEFAULT_WHO,
  WHO_OPTIONS,
  WHO_PARAM,
  whoCaption,
  type Who,
} from "@/lib/tracker/who";

// The page-wide Humans / Bots / All control on the project stats page.
//
// The selection lives in the URL (?who=), not in component state: the page
// is a server component that reads it, fetches every panel and the headline
// tiles at that filter, and keys the chart cards on it so they remount on
// fresh data. This control only navigates. Replacing rather than pushing
// keeps the back button for leaving the page, not for undoing a toggle, and
// the transition dims the strip while the new numbers are on their way so a
// click never looks ignored.
//
// Same visual language as the timeframe tabs in each card header, with
// arrow-key roving so keyboard users are not stranded on the selected option.
export function WhoToggle({ value }: { value: Who }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function select(next: Who) {
    if (next === value) return;
    const params = new URLSearchParams(searchParams?.toString());
    if (next === DEFAULT_WHO) params.delete(WHO_PARAM);
    else params.set(WHO_PARAM, next);
    const qs = params.toString();
    start(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + WHO_OPTIONS.length) % WHO_OPTIONS.length;
    refs.current[next]?.focus();
    select(WHO_OPTIONS[next].key);
  }

  const caption = whoCaption(value);

  return (
    <div className="flex flex-col items-end gap-1">
      <div
        role="tablist"
        aria-label="Who to count"
        aria-busy={pending}
        className={[
          "inline-flex shrink-0 rounded-md border border-[var(--color-border)] p-0.5 transition-opacity",
          pending ? "opacity-50" : "",
        ].join(" ")}
      >
        {WHO_OPTIONS.map((option, index) => {
          const selected = option.key === value;
          return (
            <button
              key={option.key}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={option.description}
              disabled={pending}
              onClick={() => select(option.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={[
                "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                "disabled:cursor-wait",
                selected
                  ? "bg-[var(--color-accent)] text-white"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)]",
              ].join(" ")}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {caption && (
        <p className="text-[11px] leading-snug text-[var(--color-muted)]">
          {caption}
        </p>
      )}
    </div>
  );
}
