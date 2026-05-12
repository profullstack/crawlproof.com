"use client";

import { useState, type ReactNode } from "react";

type TabKey = "report" | "structured" | "performance";

export function ViewTabs({
  markdownView,
  structuredView,
  performanceView,
  rawMarkdownUrl,
}: {
  markdownView: ReactNode;
  structuredView: ReactNode;
  performanceView?: ReactNode;
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
            <TabButton id="performance" label="Performance" badge="Premium" />
          )}
        </div>
        {rawMarkdownUrl && (
          <a
            href={rawMarkdownUrl}
            className="text-xs text-[var(--color-muted)] underline"
            target="_blank"
            rel="noreferrer"
          >
            View raw .md
          </a>
        )}
      </div>
      <div hidden={tab !== "report"}>{markdownView}</div>
      <div hidden={tab !== "structured"}>{structuredView}</div>
      {performanceView && <div hidden={tab !== "performance"}>{performanceView}</div>}
    </div>
  );
}
