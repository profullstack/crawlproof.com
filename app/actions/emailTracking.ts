"use server";

import { revalidatePath } from "next/cache";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { rotateSecret, setEnabled } from "@/lib/emailTracking/store";

// Both actions change what every future email does, so read-only members are
// refused (requireProjectAccess without allowViewer).

export async function setEmailTrackingEnabled(input: {
  projectId: string;
  enabled: boolean;
}): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string }> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };
  try {
    const row = await setEnabled(input.projectId, !!input.enabled);
    revalidatePath(`/dashboard/projects/${input.projectId}/tracking`);
    return { ok: true, enabled: row.enabled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not update tracking." };
  }
}

export async function rotateEmailTrackingSecret(input: {
  projectId: string;
}): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: access.error };
  try {
    const row = await rotateSecret(input.projectId);
    revalidatePath(`/dashboard/projects/${input.projectId}/tracking`);
    return { ok: true, secret: row.secret };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not rotate the secret." };
  }
}
