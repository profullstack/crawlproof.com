import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret } from "@/lib/sp/vault";
import { fetchEmailsForSource, type DataSourceRow } from "./connectors";

export type SyncResult = {
  ok: boolean;
  sourceId: string;
  imported: number; // distinct emails returned by the connector
  added: number; // rows newly inserted into the audience
  error?: string;
};

// Pull emails from one connected data source and upsert them into the org's
// deduped audience. Existing rows (incl. their unsubscribe state) are
// preserved — re-syncing never resurrects an unsubscribed contact.
export async function syncDataSource(
  organizationId: string,
  sourceId: string,
): Promise<SyncResult> {
  const svc = serviceClient();
  const { data: row, error } = await svc
    .from("organization_data_sources")
    .select(
      "id,organization_id,kind,enabled,supabase_url,enc_service_role_key,source_mode,table_name,email_column,turso_url,enc_auth_token,email_query",
    )
    .eq("id", sourceId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !row) {
    return { ok: false, sourceId, imported: 0, added: 0, error: error?.message ?? "Source not found." };
  }

  const src: DataSourceRow = {
    id: row.id,
    organization_id: row.organization_id,
    kind: row.kind,
    supabase_url: row.supabase_url,
    source_mode: row.source_mode,
    table_name: row.table_name,
    email_column: row.email_column,
    turso_url: row.turso_url,
    email_query: row.email_query,
  };

  try {
    if (row.enc_service_role_key) src.serviceRoleKey = decryptSecret(row.enc_service_role_key);
    if (row.enc_auth_token) src.authToken = decryptSecret(row.enc_auth_token);
  } catch {
    const msg = "Could not decrypt source credentials (check SOCIAL_VAULT_KEY).";
    await recordSyncError(svc, sourceId, msg);
    return { ok: false, sourceId, imported: 0, added: 0, error: msg };
  }

  const fetched = await fetchEmailsForSource(src);
  if (fetched.error) {
    await recordSyncError(svc, sourceId, fetched.error);
    return { ok: false, sourceId, imported: 0, added: 0, error: fetched.error };
  }

  let added = 0;
  if (fetched.emails.length > 0) {
    // Which of these already exist for this org? Page through to avoid an
    // unbounded IN list, then insert only the new ones. The unique index on
    // (organization_id, lower(email)) is the final safety net under races.
    const existing = await loadExistingEmails(svc, organizationId);
    const fresh = fetched.emails.filter((e) => !existing.has(e));
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500).map((email) => ({
        organization_id: organizationId,
        source_id: sourceId,
        email,
      }));
      const { error: insErr, count } = await svc
        .from("organization_audience_contacts")
        .upsert(chunk, { onConflict: "organization_id,email", ignoreDuplicates: true, count: "exact" });
      if (insErr) {
        // Fall back to per-row insert ignoring conflicts if the bulk upsert
        // conflict target doesn't match the functional index.
        for (const r of chunk) {
          const { error: rowErr } = await svc.from("organization_audience_contacts").insert(r);
          if (!rowErr) added += 1;
        }
        continue;
      }
      added += count ?? chunk.length;
    }
  }

  await svc
    .from("organization_data_sources")
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_count: fetched.emails.length,
      last_sync_error: null,
    })
    .eq("id", sourceId);

  return { ok: true, sourceId, imported: fetched.emails.length, added };
}

export async function syncAllForOrg(organizationId: string): Promise<SyncResult[]> {
  const svc = serviceClient();
  const { data } = await svc
    .from("organization_data_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("enabled", true);
  const results: SyncResult[] = [];
  for (const s of data ?? []) {
    results.push(await syncDataSource(organizationId, s.id as string));
  }
  return results;
}

async function loadExistingEmails(
  svc: ReturnType<typeof serviceClient>,
  organizationId: string,
): Promise<Set<string>> {
  const emails = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await svc
      .from("organization_audience_contacts")
      .select("email")
      .eq("organization_id", organizationId)
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) emails.add(String(r.email).toLowerCase());
    if (data.length < pageSize) break;
  }
  return emails;
}

async function recordSyncError(
  svc: ReturnType<typeof serviceClient>,
  sourceId: string,
  message: string,
): Promise<void> {
  await svc
    .from("organization_data_sources")
    .update({ last_synced_at: new Date().toISOString(), last_sync_error: message.slice(0, 500) })
    .eq("id", sourceId);
}
