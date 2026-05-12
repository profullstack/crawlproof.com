import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

// Pinned secret for predictable signatures across tests.
const SECRET = "stub_webhook_secret";
process.env.COINPAY_WEBHOOK_SECRET = SECRET;

import { createCheckout, verifyWebhookSignature } from "@/lib/coinpay";

function sign(body: string, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a valid HMAC-SHA256 hex signature", () => {
    const body = `{"event":"payment.completed","payment_id":"abc"}`;
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a signature signed with a different secret", () => {
    const body = `{"event":"payment.completed","payment_id":"abc"}`;
    expect(verifyWebhookSignature(body, sign(body, "WRONG"))).toBe(false);
  });

  it("rejects a signature for a different body", () => {
    const body = `{"event":"payment.completed","payment_id":"abc"}`;
    const tampered = `{"event":"payment.completed","payment_id":"xyz"}`;
    expect(verifyWebhookSignature(body, sign(tampered))).toBe(false);
  });

  it("rejects missing / empty signature", () => {
    expect(verifyWebhookSignature("{}", null)).toBe(false);
    expect(verifyWebhookSignature("{}", "")).toBe(false);
  });

  it("rejects length-mismatched signatures without throwing", () => {
    expect(() => verifyWebhookSignature("{}", "deadbeef")).not.toThrow();
    expect(verifyWebhookSignature("{}", "deadbeef")).toBe(false);
  });

  it("uses constant-time comparison (no early return on byte differ)", () => {
    // Different hash from the real one but same length. Should still return
    // false — not throw, not error — so signature checks behave consistently.
    const body = "{}";
    const fake = "0".repeat(sign(body).length);
    expect(verifyWebhookSignature(body, fake)).toBe(false);
  });
});

describe("createCheckout", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/checkouts with merchant + amount + metadata", async () => {
    const fetchMock = vi.fn(async (url, init: RequestInit | undefined) => {
      return new Response(
        JSON.stringify({ id: "cp_pay_test", hosted_url: "https://pay/x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await createCheckout({
      packId: "pack-10",
      credits: 10,
      amountCents: 1000,
      ownerId: "user_123",
      ownerEmail: "u@example.com",
      successUrl: "https://crawlproof.com/ok",
      cancelUrl: "https://crawlproof.com/cancel",
      webhookUrl: "https://crawlproof.com/api/coinpay/webhook",
      metadata: { purchase_id: "pur_abc" },
    });

    expect(r).toEqual({ paymentId: "cp_pay_test", hostedUrl: "https://pay/x" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/checkouts$/);
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(headers["x-merchant-id"]).toBeTruthy();
    const body = JSON.parse(String(init?.body));
    expect(body.amount_cents).toBe(1000);
    expect(body.currency).toBe("USD");
    expect(body.webhook_url).toMatch(/coinpay\/webhook$/);
    expect(body.metadata).toMatchObject({
      pack_id: "pack-10",
      credits: "10",
      owner_id: "user_123",
      purchase_id: "pur_abc",
    });
  });

  it("throws when CoinPay returns non-2xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      createCheckout({
        packId: "pack-1",
        credits: 1,
        amountCents: 100,
        ownerId: "u",
        successUrl: "https://x",
        cancelUrl: "https://x",
        webhookUrl: "https://x",
      }),
    ).rejects.toThrow(/CoinPay createCheckout failed/);
  });

  it("throws when the response is missing id/hostedUrl", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ unrelated: true }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      createCheckout({
        packId: "pack-1",
        credits: 1,
        amountCents: 100,
        ownerId: "u",
        successUrl: "https://x",
        cancelUrl: "https://x",
        webhookUrl: "https://x",
      }),
    ).rejects.toThrow(/missing id\/hostedUrl/);
  });
});
