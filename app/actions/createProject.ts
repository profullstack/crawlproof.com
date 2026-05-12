"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAllowedTargetUrl } from "@/lib/rateLimit";

export async function createProject(input: {
  name: string;
  url: string;
  schedule: "off" | "weekly" | "monthly";
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const check = isAllowedTargetUrl(input.url);
  if (!check.ok) return { ok: false, error: check.reason };

  const nextRunAt = input.schedule === "off"
    ? null
    : input.schedule === "weekly"
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("projects")
    .insert({
      owner_id: user.id,
      name: input.name,
      url: check.url,
      schedule: input.schedule,
      next_run_at: nextRunAt,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? "Failed." };

  revalidatePath("/dashboard");
  return { ok: true, id: data.id };
}

export async function updateSchedule(input: {
  projectId: string;
  schedule: "off" | "weekly" | "monthly";
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const nextRunAt = input.schedule === "off"
    ? null
    : input.schedule === "weekly"
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("projects")
    .update({ schedule: input.schedule, next_run_at: nextRunAt })
    .eq("id", input.projectId);
  return { ok: !error };
}
