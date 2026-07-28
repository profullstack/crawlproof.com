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
import type { CodeWaiter } from "@/lib/sp/verificationChallenge";

export type StoredSeedCredential = {
  id: string;
  host: string;
  username: string;
  loginUrl: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Non-null means a sign-in is paused, waiting for the user to enter a code. */
  verificationPrompt: string | null;
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
): Promise<(SeedCredentials & { id: string }) | null> {
  if (!organizationId || !host) return null;
  const { data } = await serviceClient()
    .from("outreach_seed_credentials")
    .select("id, username, enc_password, login_url")
    .eq("organization_id", organizationId)
    .eq("host", normalizeHost(host))
    .maybeSingle();
  if (!data) return null;

  const row = data as Record<string, string | null>;
  const enc = row.enc_password;
  if (!enc || !row.username || !row.id) return null;
  try {
    return {
      id: row.id,
      username: row.username,
      password: decryptSecret(enc),
      loginUrl: row.login_url ?? undefined,
    };
  } catch {
    return null;
  }
}


/**
 * A CodeWaiter bound to one stored credential.
 *
 * Same contract as the social-posting one (lib/sp/verificationChallenge.ts):
 * publish what the site is asking, then poll until the user answers. The code
 * is cleared the moment it is read so it cannot be replayed, and a timeout
 * hands the browser slot back rather than holding it open indefinitely.
 */
export function makeSeedCodeWaiter(
  credentialId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): CodeWaiter {
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 1000;
  const pollMs = opts.pollMs ?? 3_000;

  return async function waitForCode(prompt: string): Promise<string> {
    const sb = serviceClient();
    await sb
      .from("outreach_seed_credentials")
      .update({
        verification_prompt: prompt,
        verification_requested_at: new Date().toISOString(),
        verification_code: null,
      })
      .eq("id", credentialId);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const { data } = await sb
        .from("outreach_seed_credentials")
        .select("verification_code")
        .eq("id", credentialId)
        .maybeSingle();
      const code = ((data?.verification_code as string | null) ?? "").trim();
      if (code) {
        await sb
          .from("outreach_seed_credentials")
          .update({ verification_code: null, verification_prompt: null })
          .eq("id", credentialId);
        return code;
      }
    }

    await sb
      .from("outreach_seed_credentials")
      .update({ verification_prompt: null })
      .eq("id", credentialId);
    throw new Error("timed out waiting for the verification code");
  };
}

/** Every stored credential for an org, without the secrets. */
export async function listSeedCredentials(
  organizationId: string,
): Promise<StoredSeedCredential[]> {
  const { data } = await serviceClient()
    .from("outreach_seed_credentials")
    .select("id, host, username, login_url, verified_at, last_error, verification_prompt")
    .eq("organization_id", organizationId)
    .order("host");
  return ((data as Record<string, string | null>[] | null) ?? []).map((r) => ({
    id: r.id as string,
    host: r.host as string,
    username: r.username as string,
    loginUrl: r.login_url,
    verifiedAt: r.verified_at,
    lastError: r.last_error,
    verificationPrompt: r.verification_prompt,
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
