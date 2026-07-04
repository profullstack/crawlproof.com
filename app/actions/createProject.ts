"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { setCurrentSite } from "@/lib/lx/currentSite";
import { discoverLogoUrl } from "@/lib/discoverLogo";
import { getOrCreateDefaultOrg } from "@/lib/orgs";

const DAY_MS = 24 * 60 * 60 * 1000;

function nextRunForSchedule(
  schedule: "off" | "daily" | "weekly" | "monthly",
): string | null {
  if (schedule === "off") return null;
  const days = schedule === "daily" ? 1 : schedule === "weekly" ? 7 : 30;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export async function createProject(input: {
  name: string;
  url: string;
  schedule: "off" | "daily" | "weekly" | "monthly";
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };

  const nextRunAt = nextRunForSchedule(input.schedule);
  const org = await getOrCreateDefaultOrg({
    userId: user.id,
    email: user.email,
  });
  const insertPayload: Record<string, unknown> = {
    owner_id: user.id,
    name: input.name,
    url: check.url,
    schedule: input.schedule,
    next_run_at: nextRunAt,
  };
  if (org.id) insertPayload.organization_id = org.id;

  const { data, error } = await supabase
    .from("projects")
    .insert(insertPayload)
    .select("id")
    .single();
  if (error && org.id && /organization_id|schema cache|column/i.test(error.message ?? "")) {
    delete insertPayload.organization_id;
    const retry = await supabase
      .from("projects")
      .insert(insertPayload)
      .select("id")
      .single();
    if (retry.error || !retry.data) {
      return { ok: false, error: retry.error?.message ?? "Failed." };
    }
    await setCurrentSite(retry.data.id);
    void backfillProjectLogo(retry.data.id, check.url);
    revalidatePath("/dashboard");
    return { ok: true, id: retry.data.id };
  }
  if (error || !data) return { ok: false, error: error?.message ?? "Failed." };

  // Make the new project the active one so autoblog/social tabs land
  // on it without an extra picker click.
  await setCurrentSite(data.id);

  // Discover and cache the site's logo for the dashboard tile.
  // Fire-and-forget so a slow third-party site can't slow the
  // create-project response — the dashboard backfill will catch
  // anything this misses on the next render.
  void backfillProjectLogo(data.id, check.url);

  revalidatePath("/dashboard");
  return { ok: true, id: data.id };
}

export async function backfillProjectLogo(
  projectId: string,
  url: string,
): Promise<void> {
  try {
    const logoUrl = await discoverLogoUrl(url);
    if (!logoUrl) return;
    const svc = serviceClient();
    await svc
      .from("projects")
      .update({ logo_url: logoUrl })
      .eq("id", projectId);
  } catch (err) {
    // Silent: missing logo is a cosmetic regression, never a hard
    // failure. The dashboard falls back to a letter avatar.
    console.warn("[discoverLogo] failed for", projectId, err);
  }
}

// Re-run logo discovery for a project whose stored logo is broken (the
// dashboard's <img> onError triggers this). Unlike backfillProjectLogo it
// overwrites an existing logo_url, and clears it when nothing valid is found so
// the tile falls back to a letter avatar instead of a broken image.
export async function refetchProjectLogo(
  projectId: string,
): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  const { data: project } = await supabase
    .from("projects")
    .select("id, url")
    .eq("id", projectId)
    .maybeSingle();
  if (!project?.url) return { ok: false };

  try {
    const logoUrl = await discoverLogoUrl(project.url);
    await serviceClient()
      .from("projects")
      .update({ logo_url: logoUrl })
      .eq("id", projectId);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    console.warn("[discoverLogo] refetch failed for", projectId, err);
    return { ok: false };
  }
}

export async function updateSchedule(input: {
  projectId: string;
  schedule: "off" | "daily" | "weekly" | "monthly";
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const nextRunAt = nextRunForSchedule(input.schedule);
  const { error } = await supabase
    .from("projects")
    .update({ schedule: input.schedule, next_run_at: nextRunAt })
    .eq("id", input.projectId);
  return { ok: !error };
}
