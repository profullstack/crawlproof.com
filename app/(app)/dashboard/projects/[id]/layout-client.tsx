"use client";

import Link from "next/link";
import { ProjectTabsNav } from "@/components/project-tabs-nav";
import { ProjectStatusControls } from "@/components/project-status-controls";
import { ScheduleToggle } from "@/components/schedule-toggle";
import { RunNowButton } from "@/components/run-now-button";
import { ProjectHeaderLogo } from "@/components/project-header-logo";
import type { ProjectStatus } from "@/app/actions/projects";
import type { Engine } from "@/lib/credits";

// Owns the project-level chrome (breadcrumb + logo/title + action bar +
// tab nav) on EVERY /projects/[id]/* route, so the nav is always there
// and never shifts position between tabs. Tab pages render their inner
// content into `children`.
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
  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
          ← Dashboard
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <ProjectHeaderLogo url={logoUrl} name={name} />
          <h1 className="text-3xl font-bold">{name}</h1>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block break-all text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline"
        >
          {url}
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ProjectStatusControls projectId={projectId} status={status} />
        <ScheduleToggle projectId={projectId} current={schedule} />
        <RunNowButton projectId={projectId} url={url} engines={engines} />
      </div>

      <ProjectTabsNav projectId={projectId} />

      <div>{children}</div>
    </div>
  );
}
