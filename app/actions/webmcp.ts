"use server";

import { revalidatePath } from "next/cache";
import { requireProjectAccess } from "@/lib/lx/currentSite";

type Result = { ok: true; enabled: boolean } | { ok: false; error: string };

// Flip the WebMCP plugin on/off. Like careers, it rides on the stats tracker,
// so enabling it without the tracker would do nothing; we say so.
export async function setWebmcpEnabled(input: { projectId: string; enabled: boolean }): Promise<Result> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  if (input.enabled) {
    const { data: project } = await access.supabase
      .from("projects")
      .select("tracker_enabled")
      .eq("id", input.projectId)
      .maybeSingle();
    if (!project?.tracker_enabled) {
      return { ok: false, error: "Enable the stats tracker first. The WebMCP plugin loads through it." };
    }
  }

  const patch: Record<string, unknown> = { webmcp_enabled: input.enabled };
  if (input.enabled) patch.webmcp_enabled_at = new Date().toISOString();

  const { error } = await access.supabase.from("projects").update(patch).eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/projects/${input.projectId}/stats`);
  return { ok: true, enabled: input.enabled };
}
