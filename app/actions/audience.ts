"use server";

// Audience Hub server actions: per-project ingest key management.
// Keys authenticate POST /api/events; the plaintext is stored encrypted
// (AES-256-GCM, lib/sp/vault.ts) so members can re-reveal it on demand.

import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { mintProjectKey } from "@/lib/audience/projectKeys";
import { decryptSecret } from "@/lib/sp/vault";

export async function createProjectApiKey(input: {
  projectId: string;
  name: string;
}): Promise<{ ok: true; key: string; prefix: string } | { ok: false; error: string }> {
  const name = input.name?.trim().slice(0, 120);
  if (!name) return { ok: false, error: "Name is required." };

  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: "Not found." };
  if (access.isViewer) return { ok: false, error: "Viewers can't create API keys." };

  let minted;
  try {
    minted = mintProjectKey();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not mint key." };
  }

  const svc = serviceClient();
  const { error } = await svc.from("project_api_keys").insert({
    project_id: input.projectId,
    name,
    key_prefix: minted.prefix,
    key_hash: minted.hash,
    key_ciphertext: minted.ciphertext,
    created_by: access.userId,
  });
  if (error) return { ok: false, error: error.message };

  return { ok: true, key: minted.plaintext, prefix: minted.prefix };
}

export async function revealProjectApiKey(input: {
  projectId: string;
  keyId: string;
}): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: "Not found." };
  if (access.isViewer) return { ok: false, error: "Viewers can't reveal API keys." };

  const svc = serviceClient();
  const { data: row, error } = await svc
    .from("project_api_keys")
    .select("key_ciphertext, revoked_at")
    .eq("id", input.keyId)
    .eq("project_id", input.projectId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!row) return { ok: false, error: "Not found." };
  if (row.revoked_at) return { ok: false, error: "Key has been revoked." };
  if (!row.key_ciphertext) {
    return {
      ok: false,
      error:
        "This key predates recoverable storage and can't be shown again — generate a new one.",
    };
  }
  try {
    return { ok: true, key: decryptSecret(row.key_ciphertext as string) };
  } catch {
    return { ok: false, error: "Could not decrypt this key." };
  }
}

export async function revokeProjectApiKey(input: {
  projectId: string;
  keyId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const access = await requireProjectAccess(input.projectId);
  if (!access.ok) return { ok: false, error: "Not found." };
  if (access.isViewer) return { ok: false, error: "Viewers can't revoke API keys." };

  const svc = serviceClient();
  const { error } = await svc
    .from("project_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.keyId)
    .eq("project_id", input.projectId)
    .is("revoked_at", null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
