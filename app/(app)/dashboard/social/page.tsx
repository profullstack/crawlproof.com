import { redirect } from "next/navigation";
import { getCurrentProject } from "@/lib/lx/currentSite";

// Legacy entry point — social now lives under /projects/[id]/social.
// Resolve the active project via the picker cookie and bounce there.
export default async function SocialRedirectPage() {
  const project = await getCurrentProject({
    projectColumns: "id",
    siteColumns: "id",
  });
  if (!project) redirect("/dashboard/projects/new");
  redirect(`/dashboard/projects/${project.id}/social`);
}
