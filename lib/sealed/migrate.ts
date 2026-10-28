/**
 * One-shot migration of an owner's legacy secrets to their own key.
 *
 * Runs inside the owner's own authenticated setup/unlock request, never from a
 * job: each legacy v1 blob (SOCIAL_VAULT_KEY) or plaintext secret column owned
 * by this user is opened, re-sealed to the owner's public key ("v2:" prefix =
 * seal_version 2) and written back in the same update; plaintext columns are
 * NULLed in that update. Rows that will not open are left untouched (counted
 * as failed) so nothing is lost. With LEGACY_KEY_MIGRATION=off v1 blobs stay
 * as they are (the owner re-enters them); plaintext columns are still sealed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/service";
import { isSealedValue, sealToPublicKey } from "./crypto";
import { legacyDecryptForMigration, legacyMigrationEnabled } from "./legacy";

export type MigrationReport = { migrated: number; failed: number; skipped: number };

type Opener = (legacy: string) => string;

/** Columns holding v1 blobs, per table, and how rows map to an owner. */
export const SP_ACCOUNT_COLUMNS = [
  "enc_access_token",
  "enc_refresh_token",
  "enc_cookies",
  "enc_username",
  "enc_password",
  "enc_2fa_seed",
  "enc_app_password",
] as const;
export const OUTREACH_CONFIG_COLUMNS = ["enc_smtp_user", "enc_smtp_pass", "enc_api_key", "enc_auth_token"] as const;
/** Plaintext secret columns on organization_outreach_configs -> their enc_* home. */
export const OUTREACH_PLAINTEXT: Record<string, string> = {
  smtp_user: "enc_smtp_user",
  smtp_pass: "enc_smtp_pass",
  api_key: "enc_api_key",
  auth_token: "enc_auth_token",
};

/**
 * Pure core: given one row, return the patch that re-seals it, or null. Kept
 * free of I/O so it is unit-tested directly.
 */
export async function resealRow(
  row: Record<string, unknown>,
  columns: readonly string[],
  ownerId: string,
  publicKey: string,
  open: Opener | null,
  plaintextMap: Record<string, string> = {},
): Promise<{ patch: Record<string, string | null> | null; failed: number }> {
  const patch: Record<string, string | null> = {};
  let failed = 0;
  for (const col of columns) {
    const v = row[col];
    if (typeof v !== "string" || !v || isSealedValue(v)) continue;
    if (!open) continue; // legacy migration switched off: leave the v1 blob
    try {
      patch[col] = await sealToPublicKey(publicKey, open(v), ownerId, col);
    } catch {
      failed++;
    }
  }
  for (const [plainCol, encCol] of Object.entries(plaintextMap)) {
    const v = row[plainCol];
    if (typeof v !== "string" || !v) continue;
    const existing = patch[encCol] ?? row[encCol];
    if (!existing) patch[encCol] = await sealToPublicKey(publicKey, v, ownerId, encCol);
    patch[plainCol] = null; // never keep the plaintext copy
  }
  return { patch: Object.keys(patch).length ? patch : null, failed };
}

async function migrateTable(
  sb: SupabaseClient<any>,
  table: string,
  rows: Record<string, unknown>[],
  columns: readonly string[],
  ownerId: string,
  publicKey: string,
  open: Opener | null,
  report: MigrationReport,
  plaintextMap: Record<string, string> = {},
) {
  for (const row of rows) {
    const { patch, failed } = await resealRow(row, columns, ownerId, publicKey, open, plaintextMap);
    report.failed += failed;
    if (!patch) {
      report.skipped++;
      continue;
    }
    const { error } = await sb.from(table).update(patch).eq("id", row.id as string);
    if (error) report.failed++;
    else report.migrated++;
  }
}

export async function migrateOwnerSecrets(ownerId: string, publicKey: string): Promise<MigrationReport> {
  const sb = serviceClient();
  const report: MigrationReport = { migrated: 0, failed: 0, skipped: 0 };
  const open: Opener | null = legacyMigrationEnabled() ? legacyDecryptForMigration : null;

  const { data: accounts } = await sb
    .from("sp_account")
    .select(["id", ...SP_ACCOUNT_COLUMNS].join(", "))
    .eq("user_id", ownerId);
  await migrateTable(sb, "sp_account", (accounts as unknown as Record<string, unknown>[]) ?? [], SP_ACCOUNT_COLUMNS, ownerId, publicKey, open, report);

  const { data: orgs } = await sb.from("organizations").select("id").eq("owner_id", ownerId);
  const orgIds = ((orgs as { id: string }[] | null) ?? []).map((o) => o.id);
  if (orgIds.length) {
    const { data: cfgs } = await sb
      .from("organization_outreach_configs")
      .select(["id", ...OUTREACH_CONFIG_COLUMNS, ...Object.keys(OUTREACH_PLAINTEXT)].join(", "))
      .in("organization_id", orgIds);
    await migrateTable(
      sb,
      "organization_outreach_configs",
      (cfgs as unknown as Record<string, unknown>[]) ?? [],
      OUTREACH_CONFIG_COLUMNS,
      ownerId,
      publicKey,
      open,
      report,
      OUTREACH_PLAINTEXT,
    );

    const { data: seeds } = await sb.from("outreach_seed_credentials").select("id, enc_password").in("organization_id", orgIds);
    await migrateTable(sb, "outreach_seed_credentials", (seeds as Record<string, unknown>[]) ?? [], ["enc_password"], ownerId, publicKey, open, report);

    const { data: sources } = await sb
      .from("organization_data_sources")
      .select("id, enc_service_role_key, enc_auth_token")
      .in("organization_id", orgIds);
    await migrateTable(
      sb,
      "organization_data_sources",
      (sources as Record<string, unknown>[]) ?? [],
      ["enc_service_role_key", "enc_auth_token"],
      ownerId,
      publicKey,
      open,
      report,
    );
  }

  // Operator integrations saved by this admin (vu1nz token, in a jsonb field).
  const { data: integ } = await sb.from("integrations").select("id, encrypted_credentials").eq("user_id", ownerId).is("org_id", null);
  for (const row of (integ as { id: string; encrypted_credentials: Record<string, unknown> | null }[] | null) ?? []) {
    const tok = row.encrypted_credentials?.api_token;
    if (typeof tok !== "string" || !tok || isSealedValue(tok) || !open) continue;
    try {
      const sealed = await sealToPublicKey(publicKey, open(tok), ownerId, "integrations.vu1nz.api_token");
      const { error } = await sb
        .from("integrations")
        .update({ encrypted_credentials: { ...row.encrypted_credentials, api_token: sealed } })
        .eq("id", row.id);
      if (error) report.failed++;
      else report.migrated++;
    } catch {
      report.failed++;
    }
  }
  return report;
}
