import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const SECRET = "stub_webhook_secret";
process.env.COINPAY_WEBHOOK_SECRET = SECRET;

import { createCheckoutSession, readCoinpayWebhook, verifyWebhookSignature } from "@/lib/coinpay";
import { setPlatformConnectionRowLoaderForTests } from "@/lib/platform-integrations";

setPlatformConnectionRowLoaderForTests(async () => null);

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

describe("createCheckoutSession", () => {
  let originalFetch: typeof globalThis.fetch;
  const SID = "cs_Ju1h16BXSobdRs7XWg9MUIj0";

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const input = {
    amountCents: 1000,
    description: "10 CrawlProof scan credits",
    customerEmail: "u@example.com",
    accountId: "user_123",
    metadata: { purchase_id: "pur_abc", user_id: "user_123" },
    successUrl: "https://crawlproof.com/ok?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://crawlproof.com/cancel",
  };

  it("POSTs email, account, property and metadata to /api/checkout/sessions", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, id: SID, url: `https://stub.coinpayportal.com/checkout/${SID}`, status: "open", methods: [{ code: "USDC_POL" }, { code: "PAYPAL" }] }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const r = await createCheckoutSession(input);
    expect(r.sessionId).toBe(SID);
    expect(r.url).toBe(`https://stub.coinpayportal.com/checkout/${SID}`);
    expect(r.methods).toEqual(["USDC_POL", "PAYPAL"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // COINPAY_API_URL ending in /api must not double the /api.
    expect(String(url)).toBe("https://stub.coinpayportal.com/api/checkout/sessions");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      amount: 10,
      currency: "USD",
      customer_email: "u@example.com",
      account_id: "user_123",
      property: "crawlproof.com",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_in_minutes: 60,
    });
    expect(body.metadata).toMatchObject({ purchase_id: "pur_abc", property: "crawlproof.com" });
    expect(body.business_id).toBeUndefined();
  });

  it("refuses a checkout URL on another origin", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, id: SID, url: "https://evil.example/checkout" }), {
        status: 201, headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;
    await expect(createCheckoutSession(input)).rejects.toThrow(/another origin/);
  });

  it("surfaces CoinPay's error code", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, code: "NO_PAYMENT_METHODS", error: "none" }), {
        status: 400, headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;
    await expect(createCheckoutSession(input)).rejects.toThrow(/NO_PAYMENT_METHODS/);
  });

  it("throws on an HTML answer (wrong endpoint)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof globalThis.fetch;
    await expect(createCheckoutSession(input)).rejects.toThrow(/non-JSON/);
  });

  it("requires an email before calling CoinPay", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await expect(createCheckoutSession({ ...input, customerEmail: "" })).rejects.toThrow(/email/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readCoinpayWebhook", () => {
  it("reads the nested payload, never the event id", () => {
    const e = readCoinpayWebhook({
      id: "evt_pay1_123",
      type: "payment.confirmed",
      data: {
        payment_id: "pay1",
        status: "confirmed",
        checkout_session_id: "cs_Ju1h16BXSobdRs7XWg9MUIj0",
        account_id: "user_1",
        metadata: { purchase_id: "p1" },
      },
    });
    expect(e).toMatchObject({
      eventType: "payment.confirmed",
      paymentId: "pay1",
      status: "confirmed",
      sessionId: "cs_Ju1h16BXSobdRs7XWg9MUIj0",
      accountId: "user_1",
    });
    expect(e.metadata.purchase_id).toBe("p1");
  });

  it("falls back to a flat body", () => {
    const e = readCoinpayWebhook({ payment_id: "pay2", status: "forwarded", metadata: { checkout_session_id: "cs_Ju1h16BXSobdRs7XWg9MUIj0" } });
    expect(e.paymentId).toBe("pay2");
    expect(e.sessionId).toBe("cs_Ju1h16BXSobdRs7XWg9MUIj0");
  });
});
