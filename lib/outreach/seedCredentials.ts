// Stored logins for seed directories that gate their listings.
//
// Scoped per host and per organization: a user has one account on a
// directory, not one per search they paste in, and several campaigns
// seeding the same site should share it.
//
// The password only ever exists in the database as AES-256-GCM ciphertext
// (lib/sp/vault.ts), with the key in the app environment. A database dump
// yields nothing usable on its own — the same bar the mailbox credentials
// hold.

import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret } from "@/lib/sp/vault";
import { normalizeHost } from "./cold";
import type { SeedCredentials } from "./seedLogin";

export type StoredSeedCredential = {
  id: string;
  host: string;
  username: string;
  loginUrl: string | null;
  verifiedAt: string | null;
  lastError: string | null;
};

/** Host key for a seed URL. Credentials are matched on this. */
export function seedHost(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * The decrypted credential for a host, or null.
 *
 * Returns null rather than throwing when the ciphertext won't open: a
 * rotated vault key should stall one seed, not take down a campaign tick.
 */
export async function loadSeedCredential(
  organizationId: string,
  host: string,
): Promise<SeedCredentials | null> {
  if (!organizationId || !host) return null;
  const { data } = await serviceClient()
    .from("outreach_seed_credentials")
    .select("username, enc_password, login_url")
    .eq("organization_id", organizationId)
    .eq("host", normalizeHost(host))
    .maybeSingle();
  if (!data) return null;

  const row = data as Record<string, string | null>;
  const enc = row.enc_password;
  if (!enc || !row.username) return null;
  try {
    return {
      username: row.username,
      password: decryptSecret(enc),
      loginUrl: row.login_url ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Every stored credential for an org, without the secrets. */
export async function listSeedCredentials(
  organizationId: string,
): Promise<StoredSeedCredential[]> {
  const { data } = await serviceClient()
    .from("outreach_seed_credentials")
    .select("id, host, username, login_url, verified_at, last_error")
    .eq("organization_id", organizationId)
    .order("host");
  return ((data as Record<string, string | null>[] | null) ?? []).map((r) => ({
    id: r.id as string,
    host: r.host as string,
    username: r.username as string,
    loginUrl: r.login_url,
    verifiedAt: r.verified_at,
    lastError: r.last_error,
  }));
}

/** Record whether a credential actually got us in, for the UI to show. */
export async function recordSeedCredentialResult(input: {
  organizationId: string;
  host: string;
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  await serviceClient()
    .from("outreach_seed_credentials")
    .update(
      input.ok
        ? { verified_at: new Date().toISOString(), last_error: null }
        : { last_error: (input.error ?? "sign-in failed").slice(0, 300) },
    )
    .eq("organization_id", input.organizationId)
    .eq("host", normalizeHost(input.host));
}
