import crypto from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import {
  sanitizeAnalyticsProperties,
  sanitizeHeaderRecord,
  type JsonRecord,
} from "@/lib/posthog/events";
import { serviceClient } from "@/lib/supabase/service";

const AllowedTags = [
  "activated",
  "high_intent",
  "needs_support",
  "billing_risk",
  "enterprise_candidate",
] as const;

const AllowedOrgProperties = [
  "posthog_lifecycle_stage",
  "activation_state",
  "risk_score",
  "last_posthog_workflow_at",
] as const;

const WebhookSchema = z.object({
  action: z.enum([
    "tag_user",
    "create_alert",
    "update_org_property",
    "capture_internal_event",
  ]),
  event: z.string().min(1).max(120).default("posthog_workflow_triggered"),
  idempotency_key: z.string().min(8).max(200).optional(),
  actor: z
    .object({
      type: z.literal("posthog").default("posthog"),
      workflow_id: z.string().max(200).optional(),
      project_id: z.string().max(200).optional(),
    })
    .optional(),
  target: z
    .object({
      user_id: z.string().uuid().optional(),
      org_id: z.string().uuid().optional(),
      domain_id: z.string().uuid().optional(),
    })
    .default({}),
  properties: z.record(z.unknown()).default({}),
});

export async function POST(req: NextRequest) {
  const configuredSecret = env.posthogInboundWebhookSecret;
  if (!configuredSecret) {
    return NextResponse.json(
      { ok: false, error: "posthog_webhook_secret_not_configured" },
      { status: 503 },
    );
  }

  if (!safeEqual(req.headers.get("x-crawlproof-webhook-secret"), configuredSecret)) {
    await writeWebhookAudit({
      req,
      status: "rejected",
      responseStatus: 401,
      error: "bad_secret",
    });
    return NextResponse.json({ ok: false, error: "bad_secret" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    await writeWebhookAudit({
      req,
      status: "rejected",
      responseStatus: 400,
      error: "bad_json",
    });
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const parsed = WebhookSchema.safeParse(json);
  if (!parsed.success) {
    await writeWebhookAudit({
      req,
      requestPayload: sanitizeAnalyticsProperties(json) as JsonRecord,
      status: "rejected",
      responseStatus: 400,
      error: "invalid_payload",
      responsePayload: { issues: parsed.error.issues.slice(0, 5) },
    });
    return NextResponse.json(
      { ok: false, error: "invalid_payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const idempotencyKey =
    req.headers.get("x-idempotency-key") ?? body.idempotency_key ?? null;

  const existing = idempotencyKey
    ? await findExistingWebhookEvent(idempotencyKey)
    : null;
  if (existing) {
    return NextResponse.json({
      ok: true,
      status: "duplicate",
      webhook_event_id: existing.id,
    });
  }

  const actionError = validateAction(body.action, body.properties);
  if (actionError) {
    const event = await writeWebhookAudit({
      req,
      orgId: body.target.org_id,
      userId: body.target.user_id,
      eventName: body.event,
      action: body.action,
      idempotencyKey,
      requestPayload: sanitizeAnalyticsProperties(body) as JsonRecord,
      status: "rejected",
      responseStatus: 400,
      error: actionError,
    });
    return NextResponse.json(
      { ok: false, error: actionError, webhook_event_id: event?.id },
      { status: 400 },
    );
  }

  const responsePayload = {
    action: body.action,
    action_status: "recorded",
  };
  const event = await writeWebhookAudit({
    req,
    orgId: body.target.org_id,
    userId: body.target.user_id,
    eventName: body.event,
    action: body.action,
    idempotencyKey,
    requestPayload: sanitizeAnalyticsProperties(body) as JsonRecord,
    responsePayload,
    status: "accepted",
    responseStatus: 202,
  });

  return NextResponse.json(
    {
      ok: true,
      status: "accepted",
      webhook_event_id: event?.id,
    },
    { status: 202 },
  );
}

function validateAction(action: string, properties: Record<string, unknown>) {
  if (action === "tag_user") {
    const tag = properties.tag;
    if (!AllowedTags.includes(tag as (typeof AllowedTags)[number])) {
      return "tag_not_allowed";
    }
  }

  if (action === "update_org_property") {
    const property = properties.property;
    if (
      !AllowedOrgProperties.includes(
        property as (typeof AllowedOrgProperties)[number],
      )
    ) {
      return "org_property_not_allowed";
    }
  }

  return null;
}

async function findExistingWebhookEvent(idempotencyKey: string) {
  const { data, error } = await serviceClient()
    .from("webhook_events")
    .select("id,status")
    .eq("provider", "posthog")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as { id: string; status: string } | null;
}

async function writeWebhookAudit(input: {
  req: NextRequest;
  orgId?: string | null;
  userId?: string | null;
  eventName?: string | null;
  action?: string | null;
  idempotencyKey?: string | null;
  requestPayload?: JsonRecord;
  responsePayload?: JsonRecord | Record<string, unknown>;
  responseStatus: number;
  status: "accepted" | "duplicate" | "rejected" | "failed";
  error?: string | null;
}) {
  try {
    const { data, error } = await serviceClient()
      .from("webhook_events")
      .insert({
        org_id: input.orgId ?? null,
        user_id: input.userId ?? null,
        provider: "posthog",
        direction: "inbound",
        event_name: input.eventName ?? null,
        action: input.action ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        request_headers: sanitizeHeaderRecord(input.req.headers),
        request_payload: input.requestPayload ?? {},
        response_status: input.responseStatus,
        response_payload: (input.responsePayload ?? {}) as JsonRecord,
        status: input.status,
        error: input.error ?? null,
      })
      .select("id")
      .single();

    if (error) throw new Error(error.message);
    return data as { id: string } | null;
  } catch {
    return null;
  }
}

function safeEqual(candidate: string | null, expected: string) {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
