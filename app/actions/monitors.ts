"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { buildMonitorFields, type MonitorFieldsInput } from "@/lib/uptime-monitor-input";

export interface CreateMonitorInput extends MonitorFieldsInput {
  projectId: string;
  alertEmail?: string;
}

export async function createMonitor(
  input: CreateMonitorInput,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Same rules the partner uptime API (/api/uptime/v1) applies.
  const built = buildMonitorFields(input);
  if (!built.ok) return { ok: false, error: built.error };

  const { error } = await supabase.from("monitors").insert({
    project_id: input.projectId,
    ...built.fields,
    alert_email: (input.alertEmail || user.email || "").trim() || null,
  });
  if (error) return { ok: false, error: `Could not create monitor: ${error.message}` };

  revalidatePath(`/dashboard/projects/${input.projectId}/uptime`);
  return { ok: true };
}

export async function setMonitorEnabled(
  projectId: string,
  monitorId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("monitors")
    .update({ enabled })
    .eq("id", monitorId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/dashboard/projects/${projectId}/uptime`);
  return { ok: true };
}

export async function deleteMonitor(
  projectId: string,
  monitorId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.from("monitors").delete().eq("id", monitorId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/dashboard/projects/${projectId}/uptime`);
  return { ok: true };
}
