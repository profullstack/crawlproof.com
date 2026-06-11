import { createClient as createSb } from "@supabase/supabase-js";
import { createClient as createTurso } from "@libsql/client";

// Connectors pull every user email out of a project's own backing database.
// Supabase and Turso are the two hosted stores used across the CrawlProof
// org's projects. Each connector returns a flat, normalized email list; the
// caller (lib/audience/sync.ts) is responsible for dedup + persistence.

export type DataSourceRow = {
  id: string;
  organization_id: string;
  kind: "supabase" | "turso";
  // Supabase
  supabase_url: string | null;
  source_mode: "auth_users" | "table" | null;
  table_name: string | null;
  email_column: string | null;
  // Turso
  turso_url: string | null;
  email_query: string | null;
  // Decrypted at call time by the caller.
  serviceRoleKey?: string | null;
  authToken?: string | null;
};

export type FetchResult = { emails: string[]; error?: string };

// Normalize a raw value to a deliverable email or null. Lowercase + trim,
// require a single "@" with something either side, drop anything obviously
// junk. Mirrors lib/marketing.ts#normalize, slightly stricter.
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const e = value.trim().toLowerCase();
  if (!e || e.length > 254) return null;
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@") || at === e.length - 1) return null;
  if (/\s/.test(e)) return null;
  if (!e.slice(at + 1).includes(".")) return null;
  return e;
}

function dedupeNormalize(values: unknown[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    const e = normalizeEmail(v);
    if (e) seen.add(e);
  }
  return [...seen];
}

// Guard a user-supplied Turso query: must be a single read-only SELECT.
// The DB belongs to the org owner, so this is defense-in-depth — it stops a
// fat-fingered destructive statement, not a determined attacker.
export function assertReadOnlySelect(query: string): string | null {
  const q = query.trim().replace(/;+\s*$/, ""); // allow one trailing semicolon
  if (!q) return "Query is empty.";
  if (q.includes(";")) return "Query must be a single statement (no semicolons).";
  if (!/^\s*(with|select)\b/i.test(q)) return "Query must be a SELECT.";
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace|truncate|vacuum|reindex)\b/i.test(q)) {
    return "Query may only read data (no write/DDL keywords).";
  }
  return null;
}

export async function fetchSupabaseEmails(src: DataSourceRow): Promise<FetchResult> {
  if (!src.supabase_url) return { emails: [], error: "Supabase URL is required." };
  if (!src.serviceRoleKey) return { emails: [], error: "Service role key is required." };

  const sb = createSb(src.supabase_url, src.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (src.source_mode === "table") {
    if (!src.table_name || !src.email_column) {
      return { emails: [], error: "Table name and email column are required for table mode." };
    }
    const collected: unknown[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await sb
        .from(src.table_name)
        .select(src.email_column)
        .range(from, from + pageSize - 1);
      if (error) return { emails: [], error: error.message };
      if (!data || data.length === 0) break;
      for (const row of data) {
        collected.push((row as unknown as Record<string, unknown>)[src.email_column]);
      }
      if (data.length < pageSize) break;
    }
    return { emails: dedupeNormalize(collected) };
  }

  // Default: read auth.users via the admin API — uniform across every
  // Supabase project regardless of its public schema.
  const collected: unknown[] = [];
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) return { emails: [], error: error.message };
    const users = data?.users ?? [];
    if (users.length === 0) break;
    for (const u of users) collected.push(u.email);
    if (users.length < perPage) break;
  }
  return { emails: dedupeNormalize(collected) };
}

export async function fetchTursoEmails(src: DataSourceRow): Promise<FetchResult> {
  if (!src.turso_url) return { emails: [], error: "Turso URL is required." };
  if (!src.email_query) return { emails: [], error: "Email query is required." };
  const guardError = assertReadOnlySelect(src.email_query);
  if (guardError) return { emails: [], error: guardError };

  const client = createTurso({
    url: src.turso_url,
    authToken: src.authToken ?? undefined,
  });
  try {
    const result = await client.execute(src.email_query);
    // Prefer an "email" column if present, else the first column.
    const cols = result.columns ?? [];
    const emailIdx = cols.findIndex((c) => c?.toLowerCase() === "email");
    const values: unknown[] = result.rows.map((row) => {
      if (emailIdx >= 0) return (row as unknown as unknown[])[emailIdx];
      const arr = row as unknown as unknown[];
      return arr[0];
    });
    return { emails: dedupeNormalize(values) };
  } catch (error) {
    return { emails: [], error: error instanceof Error ? error.message : "Turso query failed." };
  } finally {
    client.close();
  }
}

export async function fetchEmailsForSource(src: DataSourceRow): Promise<FetchResult> {
  if (src.kind === "supabase") return fetchSupabaseEmails(src);
  if (src.kind === "turso") return fetchTursoEmails(src);
  return { emails: [], error: `Unknown data source kind: ${src.kind}` };
}
