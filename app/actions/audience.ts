"use server";

// Audience Hub server actions: per-project ingest key management.
// Keys authenticate POST /api/events; plaintext is shown once at mint time.

import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { mintProjectKey } from "@/lib/audience/projectKeys";

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
    created_by: access.userId,
  });
  if (error) return { ok: false, error: error.message };

  return { ok: true, key: minted.plaintext, prefix: minted.prefix };
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
