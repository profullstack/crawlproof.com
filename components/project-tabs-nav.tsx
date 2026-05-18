"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ProjectShellTab } from "./project-shell";

const TABS: { id: ProjectShellTab; label: string; href: (id: string) => string; match: RegExp }[] = [
  {
    id: "overview",
    label: "Overview",
    href: (id) => `/projects/${id}`,
    match: /^\/projects\/[^/]+\/?$/,
  },
  {
    id: "performance",
    label: "Performance",
    href: (id) => `/projects/${id}/performance`,
    match: /^\/projects\/[^/]+\/performance(\/|$)/,
  },
  {
    id: "scans",
    label: "Scans",
    href: (id) => `/projects/${id}/scans`,
    match: /^\/projects\/[^/]+\/scans(\/|$)/,
  },
  {
    id: "autoblog",
    label: "Autoblog",
    href: (id) => `/projects/${id}/autoblog`,
    match: /^\/projects\/[^/]+\/autoblog(\/|$)/,
  },
  {
    id: "social",
    label: "Social",
    href: (id) => `/projects/${id}/social`,
    match: /^\/projects\/[^/]+\/social(\/|$)/,
  },
];

// Resolves the active tab from the URL so the layout doesn't need to
// pass it down. Returns null on /projects/[id]/runs/[runId] where no
// tab should appear selected.
export function ProjectTabsNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const active = TABS.find((t) => t.match.test(pathname ?? ""));
  return (
    <nav
      role="tablist"
      className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
    >
      {TABS.map((t) => {
        const isActive = t.id === active?.id;
        return (
          <Link
            key={t.id}
            href={t.href(projectId)}
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
