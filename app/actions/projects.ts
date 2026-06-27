"use server";

import { revalidatePath } from "next/cache";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { dedupeEngines, engineAvailable, ENGINES, type Engine } from "@/lib/credits";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Fix a project's site URL (e.g. a domain typo at create time). Owner/write
// only. Re-runs the same SSRF/scheme validation as project creation, then
// keeps the linked autoblog config (lx_site) pointed at the corrected domain.
export async function updateProjectUrl(input: {
  projectId: string;
  url: string;
  name?: string;
}): Promise<{ ok: true; url: string; domain: string } | { ok: false; error: string }> {
  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };

  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  const domain = hostFromUrl(check.url);
  const patch: Record<string, unknown> = { url: check.url };
  const trimmedName = input.name?.trim();
  if (trimmedName) patch.name = trimmedName;

  const { error } = await access.supabase
    .from("projects")
    .update(patch)
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  // Keep the optional autoblog config (1:1 lx_site) in sync so its worker
  // and sitemap fetches target the corrected host. Best-effort: a project
  // with no autoblog setup simply has no row to update.
  await access.supabase
    .from("lx_site")
    .update({ url: check.url, domain })
    .eq("project_id", input.projectId);

  revalidatePath(`/projects/${input.projectId}`);
  revalidatePath("/dashboard");
  return { ok: true, url: check.url, domain };
}

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

  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  const { error } = await access.supabase
    .from("projects")
    .update({ engines: cleaned })
    .eq("id", input.projectId);
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
  const access = await requireProjectAccess(projectId);
  if (!access.ok) return { ok: false, error: access.error };

  const patch: Record<string, unknown> = { status: next };
  patch.archived_at = next === "archived" ? new Date().toISOString() : null;

  const { error } = await access.supabase
    .from("projects")
    .update(patch)
    .eq("id", projectId);
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
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };

  const patch: Record<string, unknown> = { tracker_enabled: input.enabled };
  if (input.enabled) patch.tracker_enabled_at = new Date().toISOString();

  const { error } = await access.supabase
    .from("projects")
    .update(patch)
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/stats`);
  return { ok: true, enabled: input.enabled };
}
