// Authenticated server-side ingest for the Audience Hub (PRD §2/§16).
//
//   POST /api/events
//   Authorization: Bearer cpk_...        (per-project key, hashed at rest)
//
// Trusted lifecycle events (user.created, customer.created, plan.changed,
// newsletter.unsubscribed, ...) flow through the same contact pipeline as the
// browser beacon, but with source="server". Unlike /api/track this endpoint
// is not a black hole: callers get real status codes (202/400/401/429).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ingestAudienceEvent } from "@/lib/audience/hub";
import { verifyProjectKey } from "@/lib/audience/projectKeys";

export const runtime = "nodejs";

const EVENT_NAME_RE = /^[a-z0-9_.:-]{1,80}$/;

const bodySchema = z.object({
  event: z.string().regex(EVENT_NAME_RE, "invalid event name"),
  /** Informational project slug/domain; the key already pins the project. */
  project: z.string().max(255).optional(),
  email: z.string().max(320).optional(),
  name: z.string().max(255).optional(),
  user_id: z.union([z.string().max(255), z.number()]).optional(),
  anonymous_id: z.string().max(128).optional(),
  source: z.string().max(80).optional(),
  marketing_consent: z.boolean().optional(),
  consent_type: z.string().max(64).optional(),
  plan: z.string().max(80).optional(),
  role: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  url: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  utm_source: z.string().max(255).optional(),
  utm_medium: z.string().max(255).optional(),
  utm_campaign: z.string().max(255).optional(),
  utm_content: z.string().max(255).optional(),
  utm_term: z.string().max(255).optional(),
  occurred_at: z.string().max(64).optional(),
  created_at: z.string().max(64).optional(),
  metadata: z
    .record(z.unknown())
    .optional()
    .refine((v) => v === undefined || JSON.stringify(v).length <= 8_192, {
      message: "metadata too large",
    }),
});

// Best-effort per-key rate limit. In-memory is fine for a single Railway
// instance; the worst case under multiple instances is a proportionally
// higher cap, not an open door.
const RATE_LIMIT = 600; // events per key per minute
const buckets = new Map<string, { windowStart: number; count: number }>();

function rateLimited(keyId: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(keyId);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    buckets.set(keyId, { windowStart: now, count: 1 });
    if (buckets.size > 10_000) buckets.clear(); // bound memory
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const verified = token ? await verifyProjectKey(token) : null;
  if (!verified) {
    return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }

  if (rateLimited(verified.keyId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.issues[0]?.message : "invalid JSON";
    return NextResponse.json({ error: `Invalid payload: ${detail}` }, { status: 400 });
  }

  try {
    const result = await ingestAudienceEvent({
      project: verified.project,
      event: body.event.toLowerCase(),
      source: "server",
      email: body.email,
      name: body.name,
      externalUserId: body.user_id != null ? String(body.user_id) : undefined,
      anonymousId: body.anonymous_id,
      url: body.url,
      referrer: body.referrer,
      utmSource: body.utm_source ?? (body.metadata?.utm_source as string | undefined),
      utmMedium: body.utm_medium ?? (body.metadata?.utm_medium as string | undefined),
      utmCampaign: body.utm_campaign ?? (body.metadata?.utm_campaign as string | undefined),
      utmContent: body.utm_content,
      utmTerm: body.utm_term,
      marketingConsent: body.marketing_consent,
      consentType: body.consent_type,
      plan: body.plan ?? (body.metadata?.plan as string | undefined),
      role: body.role,
      tags: body.tags,
      metadata: body.metadata,
      occurredAt: body.occurred_at ?? body.created_at,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json(
      { status: "accepted", contact_id: result.contactId },
      { status: 202 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
