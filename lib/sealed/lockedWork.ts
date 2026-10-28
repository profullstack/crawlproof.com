/**
 * What happens when a job needs an owner's sealed secrets and they are locked:
 * the job WAITS (callers leave the work due), we log one line, and we email
 * the owner once per lock episode. user_key_seal.locked_nudged_at is cleared on
 * every unlock, so the next lock nudges again; a restart does not re-spam.
 */

import { serviceClient } from "@/lib/supabase/service";
import { sendKeysLockedEmail } from "@/lib/email";
import { canOpen, hasSeal } from "./vault";

const SEEN = Symbol.for("crawlproof.sealed.lockedSeen");
type G = typeof globalThis & { [SEEN]?: Set<string> };
function seen(): Set<string> {
  const g = globalThis as G;
  if (!g[SEEN]) g[SEEN] = new Set();
  return g[SEEN]!;
}

/** Called by a unlock so the next lock episode logs + nudges again. */
export function resetLockedNotice(ownerId: string): void {
  seen().delete(ownerId);
}

export async function noteLockedWork(ownerId: string, what: string): Promise<void> {
  if (canOpen(ownerId)) return;
  if (seen().has(ownerId)) return;
  seen().add(ownerId);
  const needsSetup = !(await hasSeal(ownerId));
  console.warn(`[sealed] owner ${ownerId} ${needsSetup ? "has no key passphrase" : "is locked"}; ${what} waits until they unlock`);
  try {
    const sb = serviceClient();
    const { data: row } = await sb.from("user_key_seal").select("locked_nudged_at").eq("user_id", ownerId).maybeSingle();
    if ((row as { locked_nudged_at?: string | null } | null)?.locked_nudged_at) return;
    const { data: prof } = await sb.from("profiles").select("email").eq("id", ownerId).maybeSingle();
    const to = (prof as { email?: string | null } | null)?.email;
    if (!to) return;
    await sb
      .from("user_key_seal")
      .upsert({ user_id: ownerId, locked_nudged_at: new Date().toISOString() }, { onConflict: "user_id" });
    await sendKeysLockedEmail({ to, what, needsSetup });
  } catch (err) {
    console.warn(`[sealed] nudge for ${ownerId} failed: ${err instanceof Error ? err.message : "?"}`);
  }
}
