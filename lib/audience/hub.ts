import { serviceClient } from "@/lib/supabase/service";
import { normalizeEmail } from "./connectors";

export { normalizeEmail };

// Audience Hub ingest pipeline (PRD §17). Both ingest doors — the public
// browser beacon (/api/track) and the authenticated server endpoint
// (/api/events) — funnel through ingestAudienceEvent. Contacts dedupe by
// normalized email inside an account scope: the project's organization when
// it has one, otherwise the project owner.

export type AudienceScopeProject = {
  id: string;
  owner_id: string;
  organization_id: string | null;
};

export type AudienceIngestInput = {
  project: AudienceScopeProject;
  event: string;
  source: "browser" | "server" | "import";
  email?: string | null;
  name?: string | null;
  /** The property's own user id (their auth user id, customer id, …). */
  externalUserId?: string | null;
  anonymousId?: string | null;
  /** A prior anonymous id being aliased onto this contact (crawlproof.alias). */
  previousAnonymousId?: string | null;
  sessionId?: string | null;
  url?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  /** Explicit consent signal. undefined = no signal; never inferred. */
  marketingConsent?: boolean;
  consentType?: string | null;
  plan?: string | null;
  role?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  occurredAt?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
};

export type AudienceIngestResult =
  | { ok: true; contactId: string | null }
  | { ok: false; error: string };

// Contact lifecycle states only ever upgrade through this ladder; the
// terminal states (unsubscribed/suppressed/deleted) are handled separately
// because they must override upgrades.
const STATUS_RANK: Record<string, number> = {
  unknown: 0,
  lead: 1,
  subscriber: 2,
  user: 3,
  customer: 4,
};

const TERMINAL_STATUSES = new Set(["unsubscribed", "suppressed", "deleted"]);

/** Map an event name to the lifecycle status it implies, if any. */
export function statusForEvent(event: string): string | null {
  switch (event) {
    case "identify":
    case "lead.captured":
      return "lead";
    case "newsletter.subscribed":
      return "subscriber";
    case "user.created":
    case "user.updated":
      return "user";
    case "customer.created":
    case "customer.updated":
    case "plan.changed":
    case "payment.succeeded":
      return "customer";
    case "newsletter.unsubscribed":
      return "unsubscribed";
    case "user.deleted":
    case "account.deleted":
      return "deleted";
    default:
      return null;
  }
}

/** Events the browser beacon forwards into the audience pipeline even
 *  without an email, as long as the visitor was previously identified. */
export const AUDIENCE_BROWSER_EVENTS = new Set([
  "identify",
  "consent",
  "alias",
  "lead.captured",
  "newsletter.subscribed",
  "newsletter.unsubscribed",
]);

function textOrNull(v: string | null | undefined, max = 2048): string | null {
  if (!v || typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

type ContactRow = {
  id: string;
  status: string;
  name: string | null;
  marketing_consent: boolean;
  unsubscribed_at: string | null;
  suppressed_at: string | null;
  tags: string[] | null;
  first_url: string | null;
  first_referrer: string | null;
  first_utm_source: string | null;
  first_utm_medium: string | null;
  first_utm_campaign: string | null;
};

const CONTACT_COLS =
  "id, status, name, marketing_consent, unsubscribed_at, suppressed_at, tags, first_url, first_referrer, first_utm_source, first_utm_medium, first_utm_campaign";

export async function ingestAudienceEvent(
  input: AudienceIngestInput,
): Promise<AudienceIngestResult> {
  const svc = serviceClient();
  const scope = input.project.organization_id
    ? { organization_id: input.project.organization_id, owner_id: input.project.owner_id }
    : { organization_id: null, owner_id: input.project.owner_id };

  const email = normalizeEmail(input.email);
  const anonymousId = textOrNull(input.anonymousId, 128);
  const previousAnonymousId = textOrNull(input.previousAnonymousId, 128);
  const externalUserId = textOrNull(input.externalUserId, 255);
  const occurredAt = input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt))
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString();

  // ── Resolve the contact: email first, then known identities. ────────────
  let contact: ContactRow | null = null;

  if (email) {
    let q = svc.from("audience_contacts").select(CONTACT_COLS).eq("normalized_email", email);
    q = scope.organization_id
      ? q.eq("organization_id", scope.organization_id)
      : q.eq("owner_id", scope.owner_id).is("organization_id", null);
    const { data } = await q.maybeSingle();
    contact = (data as ContactRow | null) ?? null;
  }

  if (!contact && (externalUserId || anonymousId || previousAnonymousId)) {
    contact = await resolveByIdentity(svc, scope, [
      externalUserId ? { provider: "project_user", externalId: externalUserId } : null,
      anonymousId ? { provider: "anonymous", externalId: anonymousId } : null,
      previousAnonymousId ? { provider: "anonymous", externalId: previousAnonymousId } : null,
    ]);
  }

  if (!contact && email) {
    const { data: inserted, error: insErr } = await svc
      .from("audience_contacts")
      .insert({
        owner_id: scope.owner_id,
        organization_id: scope.organization_id,
        email: input.email!.trim().slice(0, 320),
        normalized_email: email,
        name: textOrNull(input.name, 255),
        source_project_id: input.project.id,
        first_seen_at: occurredAt,
        last_seen_at: occurredAt,
        first_url: textOrNull(input.url),
        first_referrer: textOrNull(input.referrer),
        first_utm_source: textOrNull(input.utmSource, 255),
        first_utm_medium: textOrNull(input.utmMedium, 255),
        first_utm_campaign: textOrNull(input.utmCampaign, 255),
      })
      .select(CONTACT_COLS)
      .maybeSingle();
    if (inserted) {
      contact = inserted as ContactRow;
    } else if (insErr) {
      // Unique-index race: another request created the contact between our
      // select and insert. Re-select instead of failing the event.
      let q = svc.from("audience_contacts").select(CONTACT_COLS).eq("normalized_email", email);
      q = scope.organization_id
        ? q.eq("organization_id", scope.organization_id)
        : q.eq("owner_id", scope.owner_id).is("organization_id", null);
      const { data: retry } = await q.maybeSingle();
      contact = (retry as ContactRow | null) ?? null;
      if (!contact) return { ok: false, error: insErr.message };
    }
  }

  // No email and no known identity: nothing to attach this event to.
  if (!contact) return { ok: true, contactId: null };

  // ── Update contact lifecycle, consent, attribution, traits. ─────────────
  const patch: Record<string, unknown> = { last_seen_at: occurredAt };

  const impliedStatus = statusForEvent(input.event);
  const suppressed = contact.suppressed_at != null || contact.status === "suppressed";
  if (impliedStatus && !suppressed) {
    if (TERMINAL_STATUSES.has(impliedStatus)) {
      patch.status = impliedStatus;
      if (impliedStatus === "unsubscribed" || impliedStatus === "deleted") {
        patch.marketing_consent = false;
        patch.unsubscribed_at = occurredAt;
      }
      if (impliedStatus === "deleted") {
        patch.suppressed_at = occurredAt;
        patch.suppression_reason = "account_deleted";
      }
    } else if (
      !TERMINAL_STATUSES.has(contact.status) &&
      (STATUS_RANK[impliedStatus] ?? 0) > (STATUS_RANK[contact.status] ?? 0)
    ) {
      patch.status = impliedStatus;
    }
  }

  // Explicit consent only — an account email is never auto-subscribed
  // (PRD §9). Suppression overrides any opt-in.
  if (typeof input.marketingConsent === "boolean" && !suppressed) {
    patch.marketing_consent = input.marketingConsent;
    if (input.marketingConsent) {
      patch.unsubscribed_at = null;
      if (TERMINAL_STATUSES.has((patch.status as string) ?? contact.status) && contact.status !== "deleted") {
        patch.status = "subscriber";
      }
    } else {
      patch.unsubscribed_at = occurredAt;
    }
  }

  if (input.name && textOrNull(input.name, 255) && input.name !== contact.name) {
    patch.name = textOrNull(input.name, 255);
  }

  // First-touch only fills holes; last-touch always advances.
  if (!contact.first_url && input.url) patch.first_url = textOrNull(input.url);
  if (!contact.first_referrer && input.referrer) patch.first_referrer = textOrNull(input.referrer);
  if (!contact.first_utm_source && input.utmSource) patch.first_utm_source = textOrNull(input.utmSource, 255);
  if (!contact.first_utm_medium && input.utmMedium) patch.first_utm_medium = textOrNull(input.utmMedium, 255);
  if (!contact.first_utm_campaign && input.utmCampaign) patch.first_utm_campaign = textOrNull(input.utmCampaign, 255);
  if (input.url) patch.last_url = textOrNull(input.url);
  if (input.referrer) patch.last_referrer = textOrNull(input.referrer);
  if (input.utmSource) patch.last_utm_source = textOrNull(input.utmSource, 255);
  if (input.utmMedium) patch.last_utm_medium = textOrNull(input.utmMedium, 255);
  if (input.utmCampaign) patch.last_utm_campaign = textOrNull(input.utmCampaign, 255);

  if (input.tags && input.tags.length > 0) {
    const existing = Array.isArray(contact.tags) ? contact.tags : [];
    const merged = [...new Set([...existing, ...input.tags.map((t) => String(t).slice(0, 80))])];
    if (merged.length !== existing.length) patch.tags = merged.slice(0, 100);
  }

  await svc.from("audience_contacts").update(patch).eq("id", contact.id);

  // ── Identities + project link. ───────────────────────────────────────────
  const identityRows = [
    externalUserId
      ? { contact_id: contact.id, provider: "project_user", external_id: externalUserId, project_id: input.project.id }
      : null,
    anonymousId
      ? { contact_id: contact.id, provider: "anonymous", external_id: anonymousId, project_id: input.project.id }
      : null,
    previousAnonymousId
      ? { contact_id: contact.id, provider: "anonymous", external_id: previousAnonymousId, project_id: input.project.id }
      : null,
  ].filter(Boolean) as Record<string, unknown>[];
  if (identityRows.length > 0) {
    await svc
      .from("audience_identities")
      .upsert(identityRows, { onConflict: "contact_id,provider,external_id", ignoreDuplicates: true });
  }

  const linkPatch: Record<string, unknown> = {
    contact_id: contact.id,
    project_id: input.project.id,
    last_seen_at: occurredAt,
  };
  if (externalUserId) linkPatch.external_user_id = externalUserId;
  if (input.plan) linkPatch.plan = textOrNull(input.plan, 80);
  if (input.role) linkPatch.role = textOrNull(input.role, 80);
  await svc
    .from("audience_project_links")
    .upsert(linkPatch, { onConflict: "contact_id,project_id" });

  // ── Append the event row. ────────────────────────────────────────────────
  await svc.from("audience_events").insert({
    contact_id: contact.id,
    anonymous_id: anonymousId ?? "",
    session_id: textOrNull(input.sessionId, 128) ?? "",
    project_id: input.project.id,
    event: input.event.slice(0, 80),
    source: input.source,
    url: textOrNull(input.url),
    referrer: textOrNull(input.referrer),
    utm_source: textOrNull(input.utmSource, 255),
    utm_medium: textOrNull(input.utmMedium, 255),
    utm_campaign: textOrNull(input.utmCampaign, 255),
    utm_content: textOrNull(input.utmContent, 255),
    utm_term: textOrNull(input.utmTerm, 255),
    metadata: input.metadata ?? {},
    occurred_at: occurredAt,
  });

  // ── Consent audit log (explicit signals + unsubscribe events). ──────────
  const consentValue =
    typeof input.marketingConsent === "boolean"
      ? input.marketingConsent
      : input.event === "newsletter.unsubscribed"
        ? false
        : null;
  if (consentValue !== null) {
    await svc.from("audience_consent_events").insert({
      contact_id: contact.id,
      email: email ?? "",
      project_id: input.project.id,
      consent_type: validConsentType(input.consentType) ?? "marketing_email",
      consent_value: consentValue,
      source: input.source,
      ip_hash: textOrNull(input.ipHash, 64),
      user_agent_hash: textOrNull(input.userAgentHash, 64),
      occurred_at: occurredAt,
    });
  }

  return { ok: true, contactId: contact.id };
}

const CONSENT_TYPES = new Set([
  "marketing_email",
  "transactional_email",
  "product_updates",
  "newsletter",
  "cross_property_updates",
]);

function validConsentType(t: string | null | undefined): string | null {
  return t && CONSENT_TYPES.has(t) ? t : null;
}

async function resolveByIdentity(
  svc: ReturnType<typeof serviceClient>,
  scope: { organization_id: string | null; owner_id: string },
  lookups: ({ provider: string; externalId: string } | null)[],
): Promise<ContactRow | null> {
  for (const lookup of lookups) {
    if (!lookup) continue;
    const { data: identities } = await svc
      .from("audience_identities")
      .select("contact_id")
      .eq("provider", lookup.provider)
      .eq("external_id", lookup.externalId)
      .limit(10);
    for (const row of identities ?? []) {
      let q = svc
        .from("audience_contacts")
        .select(CONTACT_COLS)
        .eq("id", (row as { contact_id: string }).contact_id);
      q = scope.organization_id
        ? q.eq("organization_id", scope.organization_id)
        : q.eq("owner_id", scope.owner_id).is("organization_id", null);
      const { data } = await q.maybeSingle();
      if (data) return data as ContactRow;
    }
  }
  return null;
}
