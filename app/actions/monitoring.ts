"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { addMonitorSite, removeMonitorSite, type MonitorSubscription } from "@/lib/monitoring";

async function ownedSubscription(subscriptionId: string): Promise<MonitorSubscription | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await serviceClient()
    .from("monitor_subscriptions")
    .select("*")
    .eq("id", subscriptionId)
    .eq("owner_id", user.id)
    .maybeSingle();
  return (data as MonitorSubscription | null) ?? null;
}

export async function addSiteAction(formData: FormData): Promise<void> {
  const sub = await ownedSubscription(String(formData.get("subscriptionId") ?? ""));
  if (!sub || sub.status !== "active") return;
  const res = await addMonitorSite(serviceClient(), sub, String(formData.get("url") ?? ""));
  if (!res.ok) console.warn("[monitoring] add site refused", res.error);
  revalidatePath("/dashboard/monitoring");
}

export async function removeSiteAction(formData: FormData): Promise<void> {
  const sub = await ownedSubscription(String(formData.get("subscriptionId") ?? ""));
  if (!sub) return;
  await removeMonitorSite(serviceClient(), sub.id, String(formData.get("watchId") ?? ""));
  revalidatePath("/dashboard/monitoring");
}

/** Self-serve cancel: monitoring runs to the end of the paid month, then stops. */
export async function setCancelAction(formData: FormData): Promise<void> {
  const sub = await ownedSubscription(String(formData.get("subscriptionId") ?? ""));
  if (!sub || sub.status !== "active") return;
  await serviceClient()
    .from("monitor_subscriptions")
    .update({ cancel_at_period_end: formData.get("cancel") === "1" })
    .eq("id", sub.id);
  revalidatePath("/dashboard/monitoring");
}
