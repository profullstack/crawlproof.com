"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { fingerprint, parsePublicKey } from "@/lib/ssh-auth-probe";

export interface CreateMonitorInput {
  projectId: string;
  name: string;
  type: "http" | "ssh" | "keyword" | "ssl" | "tcp";
  target: string;
  intervalS?: number;
  alertEmail?: string;
  keyword?: string;
  match?: "present" | "absent";
  expectedStatus?: number;
  port?: number;
  warnDays?: number;
  /** ssh: the account to check, which must exist on the host. */
  username?: string;
  /** ssh: an OpenSSH public key line. Private keys are refused. */
  publicKey?: string;
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
  if (input.type === "ssh") {
    const username = input.username?.trim() ?? "";
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/.test(username)) {
      return { ok: false, error: "A valid SSH username is required." };
    }
    const parsed = parsePublicKey(input.publicKey ?? "");
    if ("error" in parsed) return { ok: false, error: parsed.error };
    config.username = username;
    config.public_key = parsed.key.type + " " + parsed.key.getPublicSSH().toString("base64");
    config.fingerprint = fingerprint(parsed.key);
    if (parsed.key.comment) config.key_comment = parsed.key.comment;
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
