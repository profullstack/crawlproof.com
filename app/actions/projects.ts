"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dedupeEngines, engineAvailable, ENGINES, type Engine } from "@/lib/credits";

// Persist the default engine list on a project. Used by manual scans (as the
// preselected checkboxes) AND by the cron daemon — which reads the value at
// fire-time, so deselecting an engine on Monday means Tuesday's scheduled
// run skips it.
export async function updateProjectEngines(input: {
  projectId: string;
  engines: Engine[];
}): Promise<{ ok: true; engines: Engine[] } | { ok: false; error: string }> {
  const cleaned = dedupeEngines(input.engines);
  if (cleaned.length === 0) {
    return { ok: false, error: "Pick at least one engine." };
  }
  const bad = cleaned.find((e) => !engineAvailable(e));
  if (bad) {
    return { ok: false, error: `${ENGINES[bad].label} isn't available.` };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { error } = await supabase
    .from("projects")
    .update({ engines: cleaned })
    .eq("id", input.projectId)
    .eq("owner_id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, engines: cleaned };
}

export type ProjectStatus = "active" | "paused" | "archived";

type StatusOk = { ok: true; status: ProjectStatus };
type StatusErr = { ok: false; error: string };

async function setProjectStatus(
  projectId: string,
  next: ProjectStatus,
): Promise<StatusOk | StatusErr> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const patch: Record<string, unknown> = { status: next };
  patch.archived_at = next === "archived" ? new Date().toISOString() : null;

  const { error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .eq("owner_id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/dashboard");
  return { ok: true, status: next };
}

export async function pauseProject(projectId: string) {
  return setProjectStatus(projectId, "paused");
}

export async function resumeProject(projectId: string) {
  return setProjectStatus(projectId, "active");
}

export async function archiveProject(projectId: string) {
  return setProjectStatus(projectId, "archived");
}

export async function restoreProject(projectId: string) {
  return setProjectStatus(projectId, "active");
}

// Flip the drop-in stats tracker on/off for a project. Owner only.
export async function setTrackerEnabled(input: {
  projectId: string;
  enabled: boolean;
}): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const patch: Record<string, unknown> = { tracker_enabled: input.enabled };
  if (input.enabled) patch.tracker_enabled_at = new Date().toISOString();

  const { error } = await supabase
    .from("projects")
    .update(patch)
    .eq("id", input.projectId)
    .eq("owner_id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/stats`);
  return { ok: true, enabled: input.enabled };
}
