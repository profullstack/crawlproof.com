// DB-side helpers around github_installations. Used by the connect
// callback and the (future) repo-listing endpoint.

import { serviceClient } from "@/lib/supabase/service";
import { mintInstallationToken } from "./app";

interface InstallationRow {
  id: string;
  user_id: string;
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  account_id: number;
  access_token: string | null;
  access_token_expires_at: string | null;
  suspended_at: string | null;
  removed_at: string | null;
}

/**
 * Return a valid installation token for this installation. If the cached
 * token is missing or within 60s of expiry, mint a fresh one and rewrite
 * the row. Throws if the installation isn't found.
 */
export async function getOrMintInstallationToken(
  installationId: number,
  options: { minTtlMs?: number } = {},
): Promise<string> {
  const sb = serviceClient();
  const { data: row } = await sb
    .from("github_installations")
    .select("*")
    .eq("installation_id", installationId)
    .maybeSingle();
  const cached = row as InstallationRow | null;

  const now = Date.now();
  const minTtlMs = options.minTtlMs ?? 60_000;
  const stillValid =
    cached?.access_token &&
    cached?.access_token_expires_at &&
    new Date(cached.access_token_expires_at).getTime() - now > minTtlMs;

  if (stillValid && cached.access_token) {
    return cached.access_token;
  }

  const fresh = await mintInstallationToken(installationId);
  await sb
    .from("github_installations")
    .update({
      access_token: fresh.token,
      access_token_expires_at: fresh.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("installation_id", installationId);
  return fresh.token;
}

/**
 * Upsert a github_installations row when a user finishes the GitHub App
 * install flow. Includes a fresh installation token so the next page load
 * doesn't have to mint one.
 */
export async function upsertInstallation(input: {
  userId: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  accountId: number;
}): Promise<void> {
  const sb = serviceClient();
  // Mint a token up-front so the row is immediately useful.
  let token: string | null = null;
  let expiresAt: string | null = null;
  try {
    const fresh = await mintInstallationToken(input.installationId);
    token = fresh.token;
    expiresAt = fresh.expires_at;
  } catch {
    // Token mint failures are non-fatal — we can re-mint on next access.
  }

  await sb
    .from("github_installations")
    .upsert(
      {
        user_id: input.userId,
        installation_id: input.installationId,
        account_login: input.accountLogin,
        account_type: input.accountType,
        account_id: input.accountId,
        access_token: token,
        access_token_expires_at: expiresAt,
        suspended_at: null,
        removed_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,installation_id" },
    );
}
