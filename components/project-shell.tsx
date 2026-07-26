// Deprecated: the project chrome (breadcrumb, header, status controls,
// tab nav) now lives in /projects/[id]/layout.tsx + layout-client.tsx,
// so every project page picks it up automatically. ProjectShell is kept
// as a pass-through for compatibility with the six pages that still
// render <ProjectShell>{content}</ProjectShell>. Removing those wrappers
// in a follow-up PR is fine; this file is intentionally trivial.

import type { ProjectStatus } from "@/app/actions/projects";
import type { Engine } from "@/lib/credits";

export type ProjectShellTab =
  | "overview"
  | "performance"
  | "scans"
  | "stats"
  | "leads"
  | "autoblog"
  | "social"
  | "repos"
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

export function ProjectShell({
  project,
  currentTab,
  children,
}: {
  project: ProjectLite;
  currentTab: ProjectShellTab;
  children: React.ReactNode;
}) {
  // Both props are intentionally unused — the layout reads the project
  // and the tab nav resolves currentTab from the URL.
  void project;
  void currentTab;
  return <>{children}</>;
}
