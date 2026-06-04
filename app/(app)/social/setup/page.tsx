import { redirect } from "next/navigation";
import { getCurrentProject } from "@/lib/lx/currentSite";

// OAuth callbacks redirect here with ?connected= or ?error=.
// Resolve the active project and bounce to the real setup page.
type SetupSearchParams = Promise<{ connected?: string; error?: string }>;

export default async function SocialSetupRedirectPage({
  searchParams,
}: {
  searchParams: SetupSearchParams;
}) {
  const params = await searchParams;
  const project = await getCurrentProject({
    projectColumns: "id",
    siteColumns: "id",
  });
  if (!project) redirect("/projects/new");

  const qs = new URLSearchParams();
  if (params.connected) qs.set("connected", params.connected);
  if (params.error) qs.set("error", params.error);
  const suffix = qs.size ? `?${qs.toString()}` : "";
  redirect(`/projects/${project.id}/social/setup${suffix}`);
}
