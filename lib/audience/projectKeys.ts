// Per-project server ingest keys for POST /api/events.
//
// Token shape: `cpk_` prefix + 43 base64url chars from 32 bytes of
// crypto-random. Mirrors lib/sp/apiToken.ts: we never persist the
// plaintext — only the display prefix and sha256(plaintext + pepper).
// SHA-256 is fine because the plaintext carries 256 bits of entropy;
// the shared SP_TOKEN_PEPPER means a DB leak alone is useless.

import crypto from "node:crypto";
import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";

const PREFIX = "cpk_";
const PREFIX_DISPLAY_LEN = 8;

export type MintedProjectKey = {
  plaintext: string; // shown to the user ONCE; never re-derivable.
  prefix: string;
  hash: string;
};

export function mintProjectKey(): MintedProjectKey {
  if (!env.spTokenPepper) {
    throw new Error(
      "SP_TOKEN_PEPPER not set. Generate with `openssl rand -base64 32`.",
    );
  }
  const random = crypto.randomBytes(32).toString("base64url");
  const plaintext = `${PREFIX}${random}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, PREFIX_DISPLAY_LEN),
    hash: hashProjectKey(plaintext),
  };
}

export function hashProjectKey(plaintext: string): string {
  if (!env.spTokenPepper) {
    throw new Error("SP_TOKEN_PEPPER not set.");
  }
  return crypto
    .createHash("sha256")
    .update(plaintext + env.spTokenPepper, "utf8")
    .digest("hex");
}

export function isProjectKeyShape(s: string | null | undefined): boolean {
  if (!s) return false;
  return s.startsWith(PREFIX) && s.length >= 32 && s.length <= 128;
}

export type VerifiedProjectKey = {
  keyId: string;
  project: { id: string; owner_id: string; organization_id: string | null };
};

/** Resolve a bearer key to its project, or null if unknown/revoked. */
export async function verifyProjectKey(
  plaintext: string,
): Promise<VerifiedProjectKey | null> {
  if (!isProjectKeyShape(plaintext)) return null;
  const svc = serviceClient();
  const { data: key } = await svc
    .from("project_api_keys")
    .select("id, project_id, revoked_at")
    .eq("key_hash", hashProjectKey(plaintext))
    .maybeSingle();
  if (!key || key.revoked_at) return null;

  const { data: project } = await svc
    .from("projects")
    .select("id, owner_id, organization_id")
    .eq("id", key.project_id)
    .maybeSingle();
  if (!project) return null;

  // Best-effort usage stamp; never blocks ingest.
  void svc
    .from("project_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id)
    .then(undefined, () => {});

  return {
    keyId: key.id as string,
    project: project as VerifiedProjectKey["project"],
  };
}
