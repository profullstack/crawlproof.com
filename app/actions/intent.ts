"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  IntentError,
  createWatch,
  deleteWatch,
  draftLeadReply,
  runWatchNow,
  setLeadStatus,
  updateWatch,
  type WatchInput,
} from "@/lib/intent/store";

async function ownerId(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return user.id;
}

function formInput(fd: FormData): WatchInput {
  const get = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return {
    name: get("name"),
    sells: get("sells"),
    keywords: get("keywords"),
    competitors: get("competitors"),
    negative_keywords: get("negative_keywords"),
    sources: fd.getAll("sources").map(String),
    cadence: get("cadence"),
    min_score: get("min_score"),
    slack_webhook_url: get("slack_webhook_url"),
    discord_webhook_url: get("discord_webhook_url"),
    webhook_url: get("webhook_url"),
    email_digest: fd.get("email_digest") === "on",
  };
}

function back(params: Record<string, string>): never {
  redirect(`/dashboard/intent?${new URLSearchParams(params).toString()}`);
}

export async function createWatchAction(fd: FormData): Promise<void> {
  const owner = await ownerId();
  let id: string;
  try {
    id = (await createWatch(owner, formInput(fd))).id;
  } catch (err) {
    back({ error: err instanceof IntentError ? err.message : "Could not create the watch." });
  }
  // First sweep straight away, so the inbox is not empty on day one.
  const r = await runWatchNow(owner, id).catch((e) => ({ ok: false as const, error: String(e), status: 500 }));
  revalidatePath("/dashboard/intent");
  back(r.ok ? { watch: id, notice: `Watch created: ${r.inserted} leads found on the first sweep.` } : { watch: id, error: r.error });
}

export async function updateWatchAction(fd: FormData): Promise<void> {
  const owner = await ownerId();
  const id = String(fd.get("id") ?? "");
  try {
    await updateWatch(owner, id, formInput(fd));
  } catch (err) {
    back({ watch: id, error: err instanceof IntentError ? err.message : "Could not save." });
  }
  revalidatePath("/dashboard/intent");
  back({ watch: id, notice: "Saved." });
}

export async function toggleWatchAction(fd: FormData): Promise<void> {
  const owner = await ownerId();
  const id = String(fd.get("id") ?? "");
  await updateWatch(owner, id, { active: fd.get("active") === "true" });
  revalidatePath("/dashboard/intent");
  back({ watch: id });
}

export async function deleteWatchAction(fd: FormData): Promise<void> {
  const owner = await ownerId();
  await deleteWatch(owner, String(fd.get("id") ?? ""));
  revalidatePath("/dashboard/intent");
  back({ notice: "Watch deleted." });
}

export async function runWatchAction(fd: FormData): Promise<void> {
  const owner = await ownerId();
  const id = String(fd.get("id") ?? "");
  const r = await runWatchNow(owner, id).catch((e) => ({ ok: false as const, error: String(e), status: 500 }));
  revalidatePath("/dashboard/intent");
  back(r.ok ? { watch: id, notice: `Sweep done: ${r.inserted} new of ${r.found} matching posts.` } : { watch: id, error: r.error });
}

export async function setLeadStatusAction(fd: FormData): Promise<void> {
  const owner = await ownerId();
  await setLeadStatus(owner, String(fd.get("id") ?? ""), String(fd.get("status") ?? ""));
  revalidatePath("/dashboard/intent");
}

export async function draftReplyAction(leadId: string, regenerate = false): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const owner = await ownerId();
  try {
    return { ok: true, reply: await draftLeadReply(owner, leadId, regenerate) };
  } catch (err) {
    return { ok: false, error: err instanceof IntentError ? err.message : "Could not draft a reply." };
  }
}
