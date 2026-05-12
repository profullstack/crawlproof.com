import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const SECRET = "stub_webhook_secret";
process.env.COINPAY_WEBHOOK_SECRET = SECRET;

import { createCheckout, verifyWebhookSignature } from "@/lib/coinpay";

function sign(body: string, ts: number, secret = SECRET): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}

describe("verifyWebhookSignature (CoinPay/Stripe-style t=…,v1=…)", () => {
  const now = 1_770_000_000;
  const body = `{"event":"payment.completed","data":{"payment_id":"abc"}}`;

  it("accepts a valid timestamp + HMAC pair", () => {
    expect(verifyWebhookSignature(body, sign(body, now), { now })).toBe(true);
  });

  it("rejects a signature signed with the wrong secret", () => {
    expect(
      verifyWebhookSignature(body, sign(body, now, "WRONG"), { now }),
    ).toBe(false);
  });

  it("rejects a signature for a tampered body", () => {
    const tampered = `{"event":"payment.completed","data":{"payment_id":"xyz"}}`;
    expect(verifyWebhookSignature(body, sign(tampered, now), { now })).toBe(false);
  });

  it("rejects a stale timestamp (outside the 5-minute window)", () => {
    const sigAt = now - 10 * 60; // 10 minutes ago
    expect(verifyWebhookSignature(body, sign(body, sigAt), { now })).toBe(false);
  });

  it("accepts a fresh timestamp within tolerance", () => {
    const sigAt = now - 60; // 1 minute ago
    expect(verifyWebhookSignature(body, sign(body, sigAt), { now })).toBe(true);
  });

  it("supports multiple v1= parts (secret rotation)", () => {
    const goodSig = crypto
      .createHmac("sha256", SECRET)
      .update(`${now}.${body}`)
      .digest("hex");
    const bogus = "0".repeat(goodSig.length);
    const header = `t=${now},v1=${bogus},v1=${goodSig}`;
    expect(verifyWebhookSignature(body, header, { now })).toBe(true);
  });

  it("rejects missing / empty / malformed headers", () => {
    expect(verifyWebhookSignature(body, null, { now })).toBe(false);
    expect(verifyWebhookSignature(body, "", { now })).toBe(false);
    expect(verifyWebhookSignature(body, "deadbeef", { now })).toBe(false);
    expect(verifyWebhookSignature(body, `t=${now}`, { now })).toBe(false);
    expect(verifyWebhookSignature(body, `v1=abc`, { now })).toBe(false);
  });

  it("uses constant-time comparison (length-mismatched sig returns false)", () => {
    expect(verifyWebhookSignature(body, `t=${now},v1=deadbeef`, { now })).toBe(false);
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
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "cp_pay_test", hosted_url: "https://pay/x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
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
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
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

  it("throws a helpful error when CoinPay returns HTML (wrong endpoint)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<!DOCTYPE html><h1>404 Not Found</h1>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
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
    ).rejects.toThrow(/got HTML — endpoint likely wrong/);
  });

  it("throws when CoinPay returns non-2xx", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("server error", { status: 500 }),
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
      async () =>
        new Response(JSON.stringify({ unrelated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
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
