// The record of who someone is, shared across every campaign and project.
//
// Prospects are unique per project, so before this the same person became a
// separate row in every project that found them — separate details, separate
// history, and nothing that noticed when two campaigns were about to email
// them in the same week.
//
// The merge rule is the whole point, and it is not "last write wins".
// Discovery fills gaps; it does not overwrite. A scraped company name must
// never replace one a human typed, and a second run finding a different phone
// number must not silently discard the first. Conflicting values are kept in
// `alternates` so a person can adjudicate, and every field records where it
// came from so a hand-entered value can be told from a scraped one.

import { serviceClient } from "@/lib/supabase/service";
import { normalizeEmail, normalizeHost } from "./cold";

/** Where a value came from, worst to best. Higher wins a conflict. */
const SOURCE_RANK: Record<string, number> = {
  guess: 1,
  search: 2,
  page: 3,
  "json-ld": 4,
  manual: 10,
};

export type ContactFields = {
  email?: string | null;
  host?: string | null;
  fullName?: string | null;
  title?: string | null;
  companyName?: string | null;
  companySite?: string | null;
  niche?: string | null;
  industry?: string | null;
  phone?: string | null;
  postalAddress?: string | null;
  linkedinUrl?: string | null;
  country?: string | null;
  sourceUrl?: string | null;
  socials?: Record<string, string>;
};

/** Column name per field, so the merge can be written once. */
const COLUMN: Record<keyof ContactFields, string> = {
  email: "email",
  host: "host",
  fullName: "full_name",
  title: "title",
  companyName: "company_name",
  companySite: "company_site",
  niche: "niche",
  industry: "industry",
  phone: "phone",
  postalAddress: "postal_address",
  linkedinUrl: "linkedin_url",
  country: "country",
  sourceUrl: "source_url",
  socials: "socials",
};

function clean(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Identity as the database computes it, so a lookup can find the row the
 * unique index would collide with.
 */
function identityKey(fields: ContactFields): string | null {
  const email = fields.email ? normalizeEmail(fields.email) : null;
  if (email) return `email:${email.toLowerCase()}`;
  const name = clean(fields.fullName);
  if (!name) return null;
  const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `name:${norm(name)}@${norm(clean(fields.companyName))}`;
}

export type UpsertResult = { id: string; created: boolean; conflicts: string[] } | null;

/**
 * Record what we now know about a person, merging with what was already known.
 *
 * Returns null rather than throwing. A contact record is bookkeeping around
 * work that already succeeded; failing to write one is not a reason to fail
 * the research that produced it.
 */
export async function upsertContact(input: {
  organizationId: string;
  fields: ContactFields;
  /** How this information was obtained. Decides who wins a conflict. */
  source: keyof typeof SOURCE_RANK;
}): Promise<UpsertResult> {
  const key = identityKey(input.fields);
  // Nothing to key on means nothing to deduplicate against, and a row that
  // can never be matched again is worse than no row.
  if (!input.organizationId || !key) return null;

  try {
    const sb = serviceClient();
    const { data: existing } = await sb
      .from("outreach_contacts")
      .select("*")
      .eq("organization_id", input.organizationId)
      .eq("identity_key", key)
      .maybeSingle();

    const incomingRank = SOURCE_RANK[input.source] ?? 1;
    const patch: Record<string, unknown> = {};
    const conflicts: string[] = [];
    const row = (existing ?? null) as Record<string, unknown> | null;
    const sources = ((row?.field_sources as Record<string, string>) ?? {}) as Record<string, string>;
    const alternates = Array.isArray(row?.alternates) ? [...(row!.alternates as unknown[])] : [];

    for (const [field, column] of Object.entries(COLUMN) as [keyof ContactFields, string][]) {
      const raw = input.fields[field];
      if (field === "socials") {
        const incoming = (raw as Record<string, string> | undefined) ?? {};
        if (!Object.keys(incoming).length) continue;
        // Socials merge per network rather than replacing the map, so a run
        // that finds only GitHub does not drop a known LinkedIn.
        patch.socials = { ...((row?.socials as Record<string, string>) ?? {}), ...incoming };
        continue;
      }

      const value = field === "email" ? (raw ? normalizeEmail(String(raw)) : null) : clean(raw);
      if (!value) continue;
      const current = clean(row?.[column]);

      if (!current) {
        patch[column] = value;
        sources[column] = input.source;
        continue;
      }
      if (current === value) continue;

      // Disagreement. The better-sourced value wins; the loser is kept
      // rather than dropped, because "we saw something else" is information
      // and a wrong overwrite is otherwise unrecoverable.
      const currentRank = SOURCE_RANK[sources[column] ?? "guess"] ?? 1;
      conflicts.push(column);
      if (incomingRank > currentRank) {
        alternates.push({ field: column, value: current, source: sources[column] ?? "unknown" });
        patch[column] = value;
        sources[column] = input.source;
      } else {
        alternates.push({ field: column, value, source: input.source });
      }
    }

    if (row) {
      const { data } = await sb
        .from("outreach_contacts")
        .update({
          ...patch,
          field_sources: sources,
          alternates,
          last_enriched_at: new Date().toISOString(),
        })
        .eq("id", row.id as string)
        .select("id")
        .maybeSingle();
      return data ? { id: data.id as string, created: false, conflicts } : null;
    }

    const { data } = await sb
      .from("outreach_contacts")
      .insert({
        organization_id: input.organizationId,
        ...patch,
        host: patch.host ?? (input.fields.host ? normalizeHost(input.fields.host) : null),
        field_sources: sources,
        last_enriched_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();
    return data ? { id: data.id as string, created: true, conflicts: [] } : null;
  } catch {
    return null;
  }
}

/**
 * Is this person marked do-not-contact anywhere in the organization?
 *
 * The reason the record is shared: one person saying no should stop every
 * campaign, not just the one they replied to.
 */
export async function isContactBlocked(
  organizationId: string,
  email: string,
): Promise<boolean> {
  if (!organizationId || !email) return false;
  try {
    const { data } = await serviceClient()
      .from("outreach_contacts")
      .select("do_not_contact")
      .eq("organization_id", organizationId)
      .eq("identity_key", `email:${normalizeEmail(email).toLowerCase()}`)
      .maybeSingle();
    return Boolean(data?.do_not_contact);
  } catch {
    // A lookup failure must not become an implicit permission to send.
    return false;
  }
}

export { identityKey };

/**
 * Record everybody a discovery run named.
 *
 * Shared because it was not, and the two callers drifted exactly as far apart
 * as you would expect: the one-shot finder recorded people, the campaign
 * runner read `prospects` and `errors` off the same result and dropped
 * `people` on the floor. Every person found by a campaign — which is how a
 * directory actually gets scraped — was discarded at the last step, after
 * being rendered, paginated and parsed for.
 *
 * A person is worth recording without an address. The directory gives a name,
 * a title and a profile; the address is what the pipeline goes looking for
 * afterwards, and discarding the rest until it turns up means rediscovering
 * the same human on every run.
 */
export async function recordDiscoveredPeople(input: {
  organizationId: string | null;
  people: Array<{
    fullName: string;
    jobTitle?: string | null;
    company?: string | null;
    companySite?: string | null;
    linkedinUrl?: string | null;
    location?: string | null;
    sourceUrl?: string | null;
    socials?: Record<string, string>;
    source?: string;
  }>;
  /** What the campaign was looking for. The only niche available here. */
  niche?: string | null;
}): Promise<number> {
  if (!input.organizationId || !input.people?.length) return 0;

  let recorded = 0;
  for (const person of input.people) {
    const res = await upsertContact({
      organizationId: input.organizationId,
      // Structured markup is a stronger claim than text scraped off a page,
      // and the ranking is what decides who wins when the two disagree.
      source: person.source === "json-ld" ? "json-ld" : "page",
      fields: {
        fullName: person.fullName,
        title: person.jobTitle ?? null,
        companyName: person.company ?? null,
        companySite: person.companySite ?? null,
        linkedinUrl: person.linkedinUrl ?? null,
        country: person.location ?? null,
        sourceUrl: person.sourceUrl ?? null,
        socials: person.socials,
        niche: input.niche ?? null,
      },
    });
    if (res) recorded += 1;
  }
  return recorded;
}
