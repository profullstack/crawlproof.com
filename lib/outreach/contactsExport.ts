// The contacts table, as a file you can actually take away.
//
// The table is org-scoped and durable — it outlives any one campaign, which is
// the whole reason it exists separately from prospects. But a list nobody can
// see or export is not an asset, it is a table, and it had no surface at all
// until this.

import { serviceClient } from "@/lib/supabase/service";

export type ContactExportRow = {
  email: string | null;
  full_name: string | null;
  title: string | null;
  company_name: string | null;
  company_site: string | null;
  niche: string | null;
  host: string | null;
  country: string | null;
  phone: string | null;
  linkedin_url: string | null;
  source_url: string | null;
  first_seen_at: string | null;
};

export const EXPORT_COLUMNS: Array<keyof ContactExportRow> = [
  "email",
  "full_name",
  "title",
  "company_name",
  "company_site",
  "niche",
  "host",
  "country",
  "phone",
  "linkedin_url",
  "source_url",
  "first_seen_at",
];

/**
 * One CSV field.
 *
 * Quoted whenever it contains a delimiter, a quote or a newline, with inner
 * quotes doubled — RFC 4180. A leading =, +, - or @ is prefixed with a single
 * quote as well: spreadsheets treat those as formulas, and a contact list is
 * exactly the kind of file that gets opened in one without a thought.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: ContactExportRow[]): string {
  const head = EXPORT_COLUMNS.join(",");
  const body = rows.map((r) => EXPORT_COLUMNS.map((c) => csvField(r[c])).join(","));
  // CRLF and a trailing newline, which is what RFC 4180 says and what Excel
  // wants.
  return [head, ...body].join("\r\n") + "\r\n";
}

/** Every contact the organization owning this project knows about. */
export async function contactsForProject(projectId: string): Promise<ContactExportRow[]> {
  const sb = serviceClient();
  const { data: project } = await sb
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const orgId = (project?.organization_id as string | null) ?? null;
  if (!orgId) return [];

  const { data } = await sb
    .from("outreach_contacts")
    .select(EXPORT_COLUMNS.join(", "))
    .eq("organization_id", orgId)
    // Anyone who asked not to be contacted is not part of a list that exists
    // to be contacted. Excluding them here rather than at the point of sending
    // means the exported file cannot reintroduce them somewhere else.
    .eq("do_not_contact", false)
    .order("first_seen_at", { ascending: false })
    .limit(50_000);

  return (data as ContactExportRow[] | null) ?? [];
}

export type NicheCount = { niche: string; contacts: number; withEmail: number };

/**
 * What the list is made of.
 *
 * Segment size is what decides whether a list is worth anything, so the
 * breakdown is the summary rather than the total.
 */
export async function contactNiches(projectId: string): Promise<{
  total: number;
  withEmail: number;
  niches: NicheCount[];
}> {
  const sb = serviceClient();
  const { data: project } = await sb
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const orgId = (project?.organization_id as string | null) ?? null;
  if (!orgId) return { total: 0, withEmail: 0, niches: [] };

  const { data } = await sb
    .from("outreach_contacts")
    .select("niche, email")
    .eq("organization_id", orgId)
    .eq("do_not_contact", false)
    .limit(50_000);

  const rows = (data as { niche: string | null; email: string | null }[] | null) ?? [];
  const byNiche = new Map<string, NicheCount>();
  for (const r of rows) {
    const key = r.niche ?? "unsorted";
    const entry = byNiche.get(key) ?? { niche: key, contacts: 0, withEmail: 0 };
    entry.contacts += 1;
    if (r.email) entry.withEmail += 1;
    byNiche.set(key, entry);
  }

  return {
    total: rows.length,
    withEmail: rows.filter((r) => r.email).length,
    niches: [...byNiche.values()].sort((a, b) => b.contacts - a.contacts),
  };
}
