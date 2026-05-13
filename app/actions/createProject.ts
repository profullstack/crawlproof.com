"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isAllowedTargetUrl } from "@/lib/rateLimit";

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
