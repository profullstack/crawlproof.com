"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProjectTabsNav } from "@/components/project-tabs-nav";
import { ProjectStatusControls } from "@/components/project-status-controls";
import { ScheduleToggle } from "@/components/schedule-toggle";
import { RunNowButton } from "@/components/run-now-button";
import { ProjectHeaderLogo } from "@/components/project-header-logo";
import type { ProjectStatus } from "@/app/actions/projects";
import type { Engine } from "@/lib/credits";

// On the autoblog/social tabs the layout owns the header chrome.
// Mirrors ProjectShell exactly (logo + name + action bar + tabs) so the
// tabs nav stays at the same Y across all project tabs — otherwise it
// jumps when switching e.g. /scans → /autoblog because the action bar
// height changes.
export function ProjectLayoutClient({
  projectId,
  name,
  url,
  logoUrl,
  schedule,
  status,
  engines,
  children,
}: {
  projectId: string;
  name: string;
  url: string;
  logoUrl: string | null;
  schedule: "off" | "daily" | "weekly" | "monthly";
  status: ProjectStatus;
  engines: Engine[];
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const isSubTab = /\/projects\/[^/]+\/(autoblog|social)(\/|$)/.test(pathname);

  return (
    <div className="space-y-6">
      {isSubTab && (
        <>
          <div>
            <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
              ← Dashboard
            </Link>
            <div className="mt-3 flex items-center gap-3">
              <ProjectHeaderLogo url={logoUrl} name={name} />
              <h1 className="text-3xl font-bold">{name}</h1>
            </div>
            <p className="mt-1 break-all text-[var(--color-muted)]">{url}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <ProjectStatusControls projectId={projectId} status={status} />
            <ScheduleToggle projectId={projectId} current={schedule} />
            <RunNowButton projectId={projectId} url={url} engines={engines} />
          </div>

          <ProjectTabsNav projectId={projectId} />
        </>
      )}
      <div>{children}</div>
    </div>
  );
}
