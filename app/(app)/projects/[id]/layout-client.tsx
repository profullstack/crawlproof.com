"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ProjectTabsNav } from "@/components/project-tabs-nav";

// The light header (breadcrumb + name) only renders on the
// autoblog/social tabs. The overview/performance/scans tabs still
// render their own ProjectShell-based header until those pages are
// refactored to lean on the layout.
export function ProjectLayoutClient({
  projectId,
  name,
  url,
  children,
}: {
  projectId: string;
  name: string;
  url: string;
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
            <h1 className="mt-3 text-3xl font-bold">{name}</h1>
            <p className="mt-1 break-all text-[var(--color-muted)]">{url}</p>
          </div>
          <ProjectTabsNav projectId={projectId} />
        </>
      )}
      <div>{children}</div>
    </div>
  );
}
