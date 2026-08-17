import { redirect } from "next/navigation";
import { getCurrentProject } from "@/lib/lx/currentSite";

// Legacy entry point — autoblog now lives under /projects/[id]/autoblog.
// Resolve the active project via the picker cookie and bounce there.
// When the user has no projects yet, fall through to onboarding.
export default async function AutoblogRedirectPage() {
  const project = await getCurrentProject({
    projectColumns: "id",
    siteColumns: "id",
  });
  if (!project) redirect("/dashboard/projects/new");
  redirect(`/dashboard/projects/${project.id}/autoblog`);
}
