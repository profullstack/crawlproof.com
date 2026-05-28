// Per-event delivery for tracker webhooks (Stats → Webhooks tab).
// Signs requests Standard-Webhooks-style (webhook-id, webhook-timestamp,
// webhook-signature: v1,<base64 hmac-sha256>) and also sends the secret
// as a bearer token so receivers can verify whichever way they prefer.
// One attempt, 5s timeout, no retries — analytics events are high-volume
// and a retry queue belongs in a follow-up.

import { randomUUID, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type TrackerEventGeo = {
  country_code: string;
  country_name: string;
  region_code: string;
  region_name: string;
  city: string;
  timezone: string;
};

export type TrackerEvent = {
  id: string;
  type: "tracker.event" | "tracker.test";
  project_id: string;
  occurred_at: string;
  data: {
    event: string;
    bucket: string;
    page_path: string;
    page_url: string | null;
    referrer: string | null;
    referrer_host: string;
    target: string;
    user_agent: string | null;
    geo: TrackerEventGeo | null;
  };
};

export type TrackerWebhookRow = {
  id: string;
  url: string;
  secret: string;
};

export type DeliveryOutcome = {
  ok: boolean;
  status: number | null;
  error?: string;
  ms: number;
};

export function newEventId() {
  return randomUUID();
}

export function buildTrackerEvent(input: {
  type?: TrackerEvent["type"];
  project_id: string;
  data: TrackerEvent["data"];
}): TrackerEvent {
  return {
    id: newEventId(),
    type: input.type ?? "tracker.event",
    project_id: input.project_id,
    occurred_at: new Date().toISOString(),
    data: input.data,
  };
}

function signPayload(secret: string, id: string, timestamp: number, body: string) {
  const signed = `${id}.${timestamp}.${body}`;
  return createHmac("sha256", secret).update(signed).digest("base64");
}

export async function deliverTrackerEvent(
  webhook: TrackerWebhookRow,
  event: TrackerEvent,
): Promise<DeliveryOutcome> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(webhook.secret, event.id, timestamp, body);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": event.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
        authorization: `Bearer ${webhook.secret}`,
        "user-agent": "crawlproof-tracker/1.0",
      },
      body,
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - start,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function recordOutcome(
  sb: SupabaseClient<any>,
  webhookId: string,
  outcome: DeliveryOutcome,
) {
  await sb
    .from("tracker_webhooks")
    .update({
      last_delivery_at: new Date().toISOString(),
      last_response_code: outcome.status,
      last_error: outcome.ok ? null : (outcome.error ?? null),
      updated_at: new Date().toISOString(),
    })
    .eq("id", webhookId);
}

export async function deliverAndRecord(
  sb: SupabaseClient<any>,
  webhook: TrackerWebhookRow,
  event: TrackerEvent,
): Promise<DeliveryOutcome> {
  const outcome = await deliverTrackerEvent(webhook, event);
  await recordOutcome(sb, webhook.id, outcome);
  return outcome;
}
