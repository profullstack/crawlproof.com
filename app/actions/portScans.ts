"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Queue an exposed-services scan for a project's host (docs §12). The off-Railway
// prober picks up 'queued' rows, runs the scan, and writes results back. Here we
// only record the request — RLS ensures the caller owns the project.
export async function requestPortScan(
  projectId: string,
): Promise<{ ok: boolean; error?: string; scanId?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, url")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  let host: string;
  try {
    host = new URL(project.url).host;
  } catch {
    return { ok: false, error: "Project URL is not a valid host." };
  }

  const { data: inserted, error } = await supabase
    .from("port_scans")
    .insert({
      project_id: projectId,
      host,
      status: "queued",
      requested_by: user.id,
    })
    .select("id")
    .single();
  if (error) {
    // Most likely the migration hasn't been applied yet in this environment.
    return { ok: false, error: `Could not queue scan: ${error.message}` };
  }

  revalidatePath(`/projects/${projectId}/security`);
  return { ok: true, scanId: inserted.id };
}
