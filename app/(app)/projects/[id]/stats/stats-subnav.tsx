"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function StatsSubnav({ projectId }: { projectId: string }) {
  const pathname = usePathname() ?? "";
  const tabs = [
    { label: "Overview", href: `/projects/${projectId}/stats` },
    { label: "Integrations", href: `/projects/${projectId}/stats/integrations` },
  ];

  return (
    <nav
      role="tablist"
      className="flex w-fit flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
    >
      {tabs.map((tab) => {
        const active =
          tab.href.endsWith("/stats")
            ? pathname === tab.href || pathname === `${tab.href}/`
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={`rounded-md px-3 py-1.5 ${
              active
                ? "bg-[var(--color-bg)] font-semibold"
                : "text-[var(--color-muted)]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
