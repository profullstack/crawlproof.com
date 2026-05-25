"use client";

import { useState, type ReactNode } from "react";

type TabKey = "report" | "structured" | "performance";

export function ViewTabs({
  markdownView,
  structuredView,
  performanceView,
  performanceLabel = "Performance",
  rawMarkdownUrl,
}: {
  markdownView: ReactNode;
  structuredView: ReactNode;
  performanceView?: ReactNode;
  performanceLabel?: string;
  rawMarkdownUrl?: string;
}) {
  const [tab, setTab] = useState<TabKey>("report");

  function TabButton({
    id,
    label,
    badge,
  }: {
    id: TabKey;
    label: string;
    badge?: string;
  }) {
    const active = tab === id;
    return (
      <button
        role="tab"
        aria-selected={active}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 ${
          active ? "bg-[var(--color-bg)] font-semibold" : "text-[var(--color-muted)]"
        }`}
        onClick={() => setTab(id)}
      >
        <span>{label}</span>
        {badge && (
          <span className="rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-accent-fg)]">
            {badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          className="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
        >
          <TabButton id="report" label="Report" />
          <TabButton id="structured" label="Structured view" />
          {performanceView && (
            <TabButton
              id="performance"
              label={performanceLabel}
              badge="Premium"
            />
          )}
        </div>
        {rawMarkdownUrl && (
          <a
            href={rawMarkdownUrl}
            download="prompt.md"
            className="inline-flex items-center gap-2 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-fg)] shadow-sm hover:opacity-90"
            title="Markdown formatted as a prompt — paste into Claude, GPT-5, or Cursor to apply the fixes"
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 1v10" />
              <path d="M4 7l4 4 4-4" />
              <path d="M2 14h12" />
            </svg>
            Download fix prompt
          </a>
        )}
      </div>
      <div hidden={tab !== "report"}>{markdownView}</div>
      <div hidden={tab !== "structured"}>{structuredView}</div>
      {performanceView && <div hidden={tab !== "performance"}>{performanceView}</div>}
    </div>
  );
}
