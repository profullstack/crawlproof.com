"use client";

// Sub-tab bar for the Stats page. Sits below the top-level project tabs
// (Overview/Scans/Stats/...) and switches between the analytics overview
// and the per-project webhook CRUD.

import Link from "next/link";

type Tab = { id: "overview" | "webhooks"; label: string; href: string };

export function StatsSubnav({
  projectId,
  active,
}: {
  projectId: string;
  active: Tab["id"];
}) {
  const tabs: Tab[] = [
    { id: "overview", label: "Overview", href: `/projects/${projectId}/stats` },
    {
      id: "webhooks",
      label: "Webhooks",
      href: `/projects/${projectId}/stats/webhooks`,
    },
  ];
  return (
    <nav
      role="tablist"
      className="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <Link
            key={t.id}
            href={t.href}
            role="tab"
            aria-selected={isActive}
            className={`rounded-md px-3 py-1.5 ${
              isActive
                ? "bg-[var(--color-bg)] font-semibold"
                : "text-[var(--color-muted)]"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
