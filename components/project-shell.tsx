import Link from "next/link";
import { ScheduleToggle } from "@/components/schedule-toggle";
import { ProjectStatusControls } from "@/components/project-status-controls";
import { RunNowButton } from "@/components/run-now-button";
import { ProjectHeaderLogo } from "@/components/project-header-logo";
import type { ProjectStatus } from "@/app/actions/projects";
import type { Engine } from "@/lib/credits";

export type ProjectShellTab =
  | "overview"
  | "performance"
  | "scans"
  | "stats"
  | "autoblog"
  | "social"
  | "getting-started";

type ProjectLite = {
  id: string;
  name: string;
  url: string;
  schedule: "off" | "daily" | "weekly" | "monthly";
  status: ProjectStatus | null;
  engines: Engine[] | null;
  logo_url?: string | null;
};

const TABS: { id: ProjectShellTab; label: string; href: (id: string) => string }[] = [
  {
    id: "getting-started",
    label: "Getting Started",
    href: (id) => `/projects/${id}/getting-started`,
  },
  { id: "overview", label: "Overview", href: (id) => `/projects/${id}` },
  {
    id: "performance",
    label: "Performance",
    href: (id) => `/projects/${id}/performance`,
  },
  { id: "scans", label: "Scans", href: (id) => `/projects/${id}/scans` },
  { id: "stats", label: "Stats", href: (id) => `/projects/${id}/stats` },
  { id: "autoblog", label: "Autoblog", href: (id) => `/projects/${id}/autoblog` },
  { id: "social", label: "Social", href: (id) => `/projects/${id}/social` },
];

// Shared shell for the three project tab pages. Renders the breadcrumb,
// project header, action bar (status / schedule / run-now), and tab nav.
// Each tab page wraps its own content with this so we don't need a
// layout file (the run-detail page hangs off the same /projects/[id]
// route and shouldn't show the tab nav).
export function ProjectShell({
  project,
  currentTab,
  children,
}: {
  project: ProjectLite;
  currentTab: ProjectShellTab;
  children: React.ReactNode;
}) {
  const engines: Engine[] = project.engines ?? ["rule"];
  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
          ← Dashboard
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <ProjectHeaderLogo url={project.logo_url ?? null} name={project.name} />
          <h1 className="text-3xl font-bold">{project.name}</h1>
        </div>
        <p className="mt-1 break-all text-[var(--color-muted)]">{project.url}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ProjectStatusControls
          projectId={project.id}
          status={(project.status ?? "active") as ProjectStatus}
        />
        <ScheduleToggle projectId={project.id} current={project.schedule} />
        <RunNowButton
          projectId={project.id}
          url={project.url}
          engines={engines}
        />
      </div>

      <nav
        role="tablist"
        className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1 text-sm"
      >
        {TABS.map((t) => {
          const active = t.id === currentTab;
          return (
            <Link
              key={t.id}
              href={t.href(project.id)}
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

      <div>{children}</div>
    </div>
  );
}
