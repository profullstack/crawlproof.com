"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface ProjectTab {
  id: string;
  label: string;
  href: (id: string) => string;
  /** Returns true when the pathname should highlight this tab. */
  matches: (pathname: string, projectId: string) => boolean;
}

// Order = visual order in the nav.
const TABS: ProjectTab[] = [
  {
    id: "getting-started",
    label: "Getting Started",
    href: (id) => `/projects/${id}/getting-started`,
    matches: (p, id) => p.startsWith(`/projects/${id}/getting-started`),
  },
  {
    id: "overview",
    label: "Overview",
    href: (id) => `/projects/${id}`,
    // Exact match — every other tab is a sub-route, but Overview is the bare project URL.
    matches: (p, id) => p === `/projects/${id}` || p === `/projects/${id}/`,
  },
  {
    id: "performance",
    label: "Performance",
    href: (id) => `/projects/${id}/performance`,
    matches: (p, id) => p.startsWith(`/projects/${id}/performance`),
  },
  {
    id: "scans",
    label: "Scans",
    href: (id) => `/projects/${id}/scans`,
    matches: (p, id) =>
      p.startsWith(`/projects/${id}/scans`) ||
      // Run-detail pages live under /projects/[id]/runs/[runId] but
      // visually belong with the Scans tab.
      p.startsWith(`/projects/${id}/runs`),
  },
  {
    id: "stats",
    label: "Stats",
    href: (id) => `/projects/${id}/stats`,
    matches: (p, id) => p.startsWith(`/projects/${id}/stats`),
  },
  {
    id: "autoblog",
    label: "Autoblog",
    href: (id) => `/projects/${id}/autoblog`,
    matches: (p, id) => p.startsWith(`/projects/${id}/autoblog`),
  },
  {
    id: "social",
    label: "Social",
    href: (id) => `/projects/${id}/social`,
    matches: (p, id) => p.startsWith(`/projects/${id}/social`),
  },
  {
    id: "repos",
    label: "Repos",
    href: (id) => `/projects/${id}/repos`,
    matches: (p, id) => p.startsWith(`/projects/${id}/repos`),
  },
];

export function ProjectTabsNav({ projectId }: { projectId: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav
      role="tablist"
      className="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
    >
      {TABS.map((t) => {
        const active = t.matches(pathname, projectId);
        return (
          <Link
            key={t.id}
            href={t.href(projectId)}
            role="tab"
            aria-selected={active}
            className={`rounded-md px-3 py-1.5 ${
              active
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
