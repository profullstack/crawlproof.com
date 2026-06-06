import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  existing: null as { id: string; status: string } | null,
}));

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle() {
        return { data: mockState.existing, error: null };
      },
      insert(row: Record<string, unknown>) {
        mockState.inserts.push(row);
        return {
          select() {
            return {
              single() {
                return { data: { id: "webhook-event-1" }, error: null };
              },
            };
          },
        };
      },
    }),
  }),
}));

const { POST } = await import("@/app/api/integrations/posthog/webhook/route");

describe("PostHog inbound webhook route", () => {
  beforeEach(() => {
    mockState.inserts = [];
    mockState.existing = null;
  });

  it("rejects requests without the shared secret", async () => {
    const res = await POST(
      webhookRequest({
        secret: "wrong",
        body: { action: "create_alert", properties: { title: "Spike" } },
      }),
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "bad_secret" });
    expect(mockState.inserts[0]).toMatchObject({
      provider: "posthog",
      direction: "inbound",
      status: "rejected",
      error: "bad_secret",
    });
  });

  it("accepts allowlisted actions and writes an audit log", async () => {
    const res = await POST(
      webhookRequest({
        idempotencyKey: "workflow-run-123",
        body: {
          action: "tag_user",
          event: "posthog_workflow_triggered",
          target: {
            user_id: "11111111-1111-1111-1111-111111111111",
            org_id: "22222222-2222-2222-2222-222222222222",
          },
          properties: { tag: "activated", reason: "completed_activation" },
        },
      }),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      status: "accepted",
      webhook_event_id: "webhook-event-1",
    });
    expect(mockState.inserts[0]).toMatchObject({
      org_id: "22222222-2222-2222-2222-222222222222",
      user_id: "11111111-1111-1111-1111-111111111111",
      provider: "posthog",
      direction: "inbound",
      event_name: "posthog_workflow_triggered",
      action: "tag_user",
      idempotency_key: "workflow-run-123",
      status: "accepted",
      response_status: 202,
    });
  });

  it("returns duplicate when the idempotency key was already processed", async () => {
    mockState.existing = { id: "existing-webhook-event", status: "accepted" };

    const res = await POST(
      webhookRequest({
        idempotencyKey: "workflow-run-123",
        body: {
          action: "create_alert",
          event: "posthog_workflow_triggered",
          properties: { title: "Already seen" },
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      status: "duplicate",
      webhook_event_id: "existing-webhook-event",
    });
    expect(mockState.inserts).toHaveLength(0);
  });

  it("rejects unsupported tag values", async () => {
    const res = await POST(
      webhookRequest({
        idempotencyKey: "workflow-run-456",
        body: {
          action: "tag_user",
          event: "posthog_workflow_triggered",
          properties: { tag: "admin" },
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "tag_not_allowed",
      webhook_event_id: "webhook-event-1",
    });
    expect(mockState.inserts[0]).toMatchObject({
      action: "tag_user",
      status: "rejected",
      error: "tag_not_allowed",
    });
  });
});

function webhookRequest(input: {
  body: Record<string, unknown>;
  secret?: string;
  idempotencyKey?: string;
}) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-crawlproof-webhook-secret":
      input.secret ?? "stub_posthog_webhook_secret",
  });
  if (input.idempotencyKey) {
    headers.set("x-idempotency-key", input.idempotencyKey);
  }

  return new NextRequest(
    "http://localhost/api/integrations/posthog/webhook",
    {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
    },
  );
}
