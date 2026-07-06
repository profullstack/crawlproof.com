"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface CreateMonitorInput {
  projectId: string;
  name: string;
  type: "http" | "keyword" | "ssl" | "tcp";
  target: string;
  intervalS?: number;
  alertEmail?: string;
  keyword?: string;
  match?: "present" | "absent";
  expectedStatus?: number;
  port?: number;
  warnDays?: number;
}

export async function createMonitor(
  input: CreateMonitorInput,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const name = input.name.trim();
  const target = input.target.trim();
  if (!name || !target) return { ok: false, error: "Name and target are required." };

  const config: Record<string, unknown> = {};
  if (input.type === "keyword") {
    if (!input.keyword?.trim()) return { ok: false, error: "Keyword is required." };
    config.keyword = input.keyword.trim();
    config.match = input.match ?? "present";
  }
  if (input.type === "http" && input.expectedStatus) config.expected_status = input.expectedStatus;
  if (input.type === "tcp" && input.port) config.port = input.port;
  if (input.type === "ssl" && input.warnDays) config.warn_days = input.warnDays;

  const { error } = await supabase.from("monitors").insert({
    project_id: input.projectId,
    name,
    type: input.type,
    target,
    config,
    interval_s: input.intervalS && input.intervalS >= 60 ? input.intervalS : 60,
    alert_email: (input.alertEmail || user.email || "").trim() || null,
  });
  if (error) return { ok: false, error: `Could not create monitor: ${error.message}` };

  revalidatePath(`/projects/${input.projectId}/uptime`);
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
  revalidatePath(`/projects/${projectId}/uptime`);
  return { ok: true };
}

export async function deleteMonitor(
  projectId: string,
  monitorId: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.from("monitors").delete().eq("id", monitorId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/uptime`);
  return { ok: true };
}
