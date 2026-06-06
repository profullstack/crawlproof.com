import { describe, expect, it } from "vitest";

import {
  buildPostHogCapturePayload,
  makePostHogIdempotencyKey,
  sanitizeAnalyticsProperties,
} from "@/lib/posthog/events";

describe("PostHog integration contract", () => {
  it("redacts secrets and hashes raw identifiers before analytics delivery", () => {
    const sanitized = sanitizeAnalyticsProperties({
      api_key: "phc_secret",
      accessToken: "oauth-secret",
      ip: "203.0.113.10",
      user_agent: "Mozilla/5.0 Test",
      path: "/pricing?email=a@example.com&utm_source=test&token=abc",
    }) as Record<string, string>;

    expect(sanitized.api_key).toBe("[REDACTED]");
    expect(sanitized.accessToken).toBe("[REDACTED]");
    expect(sanitized.ip).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sanitized.user_agent).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sanitized.path).toContain("email=%5BREDACTED%5D");
    expect(sanitized.path).toContain("token=%5BREDACTED%5D");
    expect(sanitized.path).toContain("utm_source=test");
  });

  it("builds a stable PostHog capture payload with identity properties", () => {
    const payload = buildPostHogCapturePayload({
      event: "crawler_detected",
      distinctId: "org_123",
      orgId: "11111111-1111-1111-1111-111111111111",
      domainId: "22222222-2222-2222-2222-222222222222",
      domain: "example.com",
      plan: "pro",
      properties: {
        crawler_category: "ai_agent",
        ip_address: "203.0.113.10",
      },
    });

    expect(payload.event).toBe("crawler_detected");
    expect(payload.distinct_id).toBe("org_123");
    expect(payload.properties).toMatchObject({
      org_id: "11111111-1111-1111-1111-111111111111",
      domain_id: "22222222-2222-2222-2222-222222222222",
      domain: "example.com",
      plan: "pro",
      source: "crawlproof",
    });
    expect((payload.properties as Record<string, string>).ip_address).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
  });

  it("generates deterministic idempotency keys within the same timestamp bucket", () => {
    const timestamp = new Date("2026-06-06T18:00:20.000Z");
    const a = makePostHogIdempotencyKey({
      orgId: "org-1",
      eventName: "script_installed",
      sourceRecordId: "site-1",
      timestamp,
    });
    const b = makePostHogIdempotencyKey({
      orgId: "org-1",
      eventName: "script_installed",
      sourceRecordId: "site-1",
      timestamp: new Date("2026-06-06T18:00:50.000Z"),
    });

    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
