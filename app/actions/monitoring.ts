"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { addMonitorSite, removeMonitorSite, startMonitorTrial, type MonitorSubscription } from "@/lib/monitoring";

/** Start the free 30-day Solo monitoring trial, optionally with a first site. */
export async function startTrialAction(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return;
  const svc = serviceClient();
  const res = await startMonitorTrial(svc, { id: user.id, email: user.email });
  if (!res.ok) {
    console.warn("[monitoring] trial refused", res.error);
    revalidatePath("/dashboard/monitoring");
    return;
  }
  const url = String(formData.get("url") ?? "").trim();
  if (url) {
    const { data: sub } = await svc.from("monitor_subscriptions").select("*").eq("id", res.subscriptionId).single();
    if (sub) await addMonitorSite(svc, sub as MonitorSubscription, url);
  }
  revalidatePath("/dashboard/monitoring");
}

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
