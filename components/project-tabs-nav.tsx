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
    href: (id) => `/dashboard/projects/${id}/getting-started`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/getting-started`),
  },
  {
    id: "overview",
    label: "Overview",
    href: (id) => `/dashboard/projects/${id}`,
    // Exact match — every other tab is a sub-route, but Overview is the bare project URL.
    matches: (p, id) => p === `/dashboard/projects/${id}` || p === `/dashboard/projects/${id}/`,
  },
  {
    id: "performance",
    label: "Performance",
    href: (id) => `/dashboard/projects/${id}/performance`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/performance`),
  },
  {
    id: "scans",
    label: "Scans",
    href: (id) => `/dashboard/projects/${id}/scans`,
    matches: (p, id) =>
      p.startsWith(`/dashboard/projects/${id}/scans`) ||
      // Run-detail pages live under /projects/[id]/runs/[runId] but
      // visually belong with the Scans tab.
      p.startsWith(`/dashboard/projects/${id}/runs`),
  },
  {
    id: "stats",
    label: "Stats",
    href: (id) => `/dashboard/projects/${id}/stats`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/stats`),
  },
  {
    id: "security",
    label: "Security",
    href: (id) => `/dashboard/projects/${id}/security`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/security`),
  },
  {
    id: "uptime",
    label: "Uptime",
    href: (id) => `/dashboard/projects/${id}/uptime`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/uptime`),
  },
  {
    id: "leads",
    label: "Leads",
    href: (id) => `/dashboard/projects/${id}/leads`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/leads`),
  },
  {
    id: "autoblog",
    label: "Autoblog",
    href: (id) => `/dashboard/projects/${id}/autoblog`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/autoblog`),
  },
  {
    id: "social",
    label: "Social",
    href: (id) => `/dashboard/projects/${id}/social`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/social`),
  },
  {
    id: "repos",
    label: "Repos",
    href: (id) => `/dashboard/projects/${id}/repos`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/repos`),
  },
  {
    id: "members",
    label: "Members",
    href: (id) => `/dashboard/projects/${id}/members`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/members`),
  },
  {
    id: "settings",
    label: "Settings",
    href: (id) => `/dashboard/projects/${id}/settings`,
    matches: (p, id) => p.startsWith(`/dashboard/projects/${id}/settings`),
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
