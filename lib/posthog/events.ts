import crypto from "node:crypto";

import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";

export const POSTHOG_EVENT_CATEGORIES = [
  "product",
  "bot",
  "rule",
  "link_exchange",
  "billing",
  "debug",
] as const;

export type PostHogEventCategory = (typeof POSTHOG_EVENT_CATEGORIES)[number];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type CapturePostHogEventInput = {
  event: string;
  distinctId: string;
  orgId?: string | null;
  userId?: string | null;
  domainId?: string | null;
  domain?: string | null;
  plan?: string | null;
  category?: PostHogEventCategory;
  properties?: Record<string, unknown>;
  sourceRecordId?: string | null;
  destination?: string | null;
  idempotencyKey?: string | null;
};

const SECRET_KEY_RE =
  /api[_-]?key|token|secret|password|authorization|cookie|session|signature|access[_-]?token|refresh[_-]?token/i;
const IP_KEY_RE = /^(ip|ip_address|remote_ip|client_ip)$/i;
const USER_AGENT_KEY_RE = /^(user_agent|useragent|ua)$/i;
const SENSITIVE_QUERY_RE =
  /token|key|secret|password|session|email|auth|code|signature/i;

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashSensitiveValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return sha256Hex(value.trim());
}

export function makePostHogIdempotencyKey(input: {
  provider?: string;
  orgId?: string | null;
  eventName: string;
  sourceRecordId?: string | null;
  timestamp?: Date;
}): string {
  const timestamp = input.timestamp ?? new Date();
  const bucket = Math.floor(timestamp.getTime() / 60_000);
  return sha256Hex(
    [
      input.provider ?? "posthog",
      input.orgId ?? "internal",
      input.eventName,
      input.sourceRecordId ?? "manual",
      String(bucket),
    ].join(":"),
  );
}

export function sanitizeAnalyticsProperties(
  value: unknown,
  key = "",
  depth = 0,
): JsonValue {
  if (depth > 8) return "[Max depth exceeded]";

  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (typeof value === "string") {
    if (SECRET_KEY_RE.test(key)) return "[REDACTED]";
    if (IP_KEY_RE.test(key) || USER_AGENT_KEY_RE.test(key)) {
      const hashed = hashSensitiveValue(value);
      return hashed ? `sha256:${hashed}` : null;
    }
    return redactSensitiveQueryParams(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeAnalyticsProperties(item, key, depth + 1));
  }

  if (typeof value === "object") {
    const out: JsonRecord = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[childKey] = sanitizeAnalyticsProperties(
        childValue,
        childKey,
        depth + 1,
      );
    }
    return out;
  }

  return String(value);
}

export function sanitizeHeaderRecord(headers: Headers): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, value] of headers.entries()) {
    out[key] = sanitizeAnalyticsProperties(value, key);
  }
  return out;
}

export function buildPostHogCapturePayload(
  input: CapturePostHogEventInput,
): JsonRecord {
  const properties = sanitizeAnalyticsProperties(
    input.properties ?? {},
  ) as JsonRecord;

  return {
    event: input.event,
    distinct_id: input.distinctId,
    properties: {
      ...properties,
      user_id: input.userId ?? null,
      org_id: input.orgId ?? null,
      domain_id: input.domainId ?? null,
      domain: input.domain ?? null,
      plan: input.plan ?? "free",
      source: "crawlproof",
      environment: process.env.NODE_ENV ?? "development",
    },
  };
}

export async function enqueuePostHogEvent(input: CapturePostHogEventInput) {
  const destination = normalizePostHogHost(input.destination ?? env.posthogHost);
  const payload = buildPostHogCapturePayload(input);
  const idempotencyKey =
    input.idempotencyKey ??
    makePostHogIdempotencyKey({
      orgId: input.orgId,
      eventName: input.event,
      sourceRecordId: input.sourceRecordId,
    });

  const svc = serviceClient();
  const row = {
    org_id: input.orgId ?? null,
    user_id: input.userId ?? null,
    provider: "posthog",
    destination,
    event_name: input.event,
    category: input.category ?? "product",
    payload,
    idempotency_key: idempotencyKey,
    status: "pending",
    next_attempt_at: new Date().toISOString(),
  };

  const { data, error } = await svc
    .from("event_outbox")
    .upsert(row, {
      onConflict: "provider,destination,idempotency_key",
      ignoreDuplicates: true,
    })
    .select("id,status")
    .maybeSingle();

  if (error) throw new Error(error.message);
  return { id: data?.id as string | undefined, idempotencyKey };
}

export function normalizePostHogHost(host?: string | null): string {
  const trimmed = host?.trim();
  if (!trimmed) return "https://app.posthog.com";
  return trimmed.replace(/\/+$/, "");
}

function redactSensitiveQueryParams(value: string): string {
  if (!value.includes("?")) return value;

  try {
    const isAbsolute = /^https?:\/\//i.test(value);
    const url = new URL(value, isAbsolute ? undefined : "https://crawlproof.local");
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_RE.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    if (isAbsolute) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}
