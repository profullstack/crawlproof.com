/**
 * Unlock / lock for one owner, used by the Next API routes AND the worker.
 *
 * Both processes run in the app container (start.sh) and each needs the
 * owner's private key in its own memory: the Next server for interactive
 * posts, the worker for scheduled ones. The Next route unlocks locally, then
 * forwards the same data key to the worker over 127.0.0.1 with
 * WORKER_SHARED_SECRET. The data key is never logged, stored or returned.
 */

import { serviceClient } from "@/lib/supabase/service";
import { base64ToBytes, clampUnlockTtlSeconds, openPrivateKey, wipe, WrongPassphraseError } from "./crypto";
import { lockOwner, unlockOwner, unlockStatus } from "./unlockStore";
import { forgetCachedSeal, loadSeal } from "./vault";
import { resetLockedNotice } from "./lockedWork";
import { resetOperatorAlert } from "./operator";

export class UnlockError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UnlockError";
    this.status = status;
  }
}

/** Verify a data key against the owner's seal and hold their private key in memory. */
export async function unlockWithDataKey(ownerId: string, dekB64: string, ttlSeconds: unknown): Promise<{ expiresAt: string }> {
  if (typeof dekB64 !== "string" || !dekB64) throw new UnlockError("dek required");
  forgetCachedSeal(ownerId);
  const seal = await loadSeal(ownerId);
  if (!seal) throw new UnlockError("no key passphrase set up yet", 409);
  let dek: Uint8Array | null = null;
  try {
    dek = base64ToBytes(dekB64);
    const key = await openPrivateKey(dek, seal, ownerId);
    const { expiresAt } = unlockOwner(ownerId, key, clampUnlockTtlSeconds(ttlSeconds));
    resetLockedNotice(ownerId);
    resetOperatorAlert();
    return { expiresAt: new Date(expiresAt).toISOString() };
  } catch (err) {
    if (err instanceof WrongPassphraseError) throw new UnlockError("wrong key", 403);
    if (err instanceof UnlockError) throw err;
    throw new UnlockError("could not unlock", 400);
  } finally {
    wipe(dek);
  }
}

export function lockLocal(ownerId: string): void {
  lockOwner(ownerId);
}

export function localStatus(ownerId: string) {
  return unlockStatus(ownerId);
}

/** Clear the "already nudged" mark so the next lock episode emails once more. */
export async function clearNudge(ownerId: string): Promise<void> {
  await serviceClient().from("user_key_seal").update({ locked_nudged_at: null }).eq("user_id", ownerId);
}

function workerUrl(): string {
  return (process.env.WORKER_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
}

/** Forward an unlock or lock to the worker process. Returns false if the worker did not accept it. */
export async function forwardToWorker(
  path: "/sealed/unlock" | "/sealed/lock",
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${workerUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": process.env.WORKER_SHARED_SECRET ?? "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
