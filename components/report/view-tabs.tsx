"use client";

import { useState, type ReactNode } from "react";

export function ViewTabs({
  markdownView,
  structuredView,
  rawMarkdownUrl,
}: {
  markdownView: ReactNode;
  structuredView: ReactNode;
  rawMarkdownUrl?: string;
}) {
  const [tab, setTab] = useState<"report" | "structured">("report");
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div role="tablist" className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm">
          <button
            role="tab"
            aria-selected={tab === "report"}
            className={`rounded-md px-3 py-1.5 ${tab === "report" ? "bg-[var(--color-bg)] font-semibold" : "text-[var(--color-muted)]"}`}
            onClick={() => setTab("report")}
          >
            Report
          </button>
          <button
            role="tab"
            aria-selected={tab === "structured"}
            className={`rounded-md px-3 py-1.5 ${tab === "structured" ? "bg-[var(--color-bg)] font-semibold" : "text-[var(--color-muted)]"}`}
            onClick={() => setTab("structured")}
          >
            Structured view
          </button>
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
    </div>
  );
}
