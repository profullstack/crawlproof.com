import crypto from "node:crypto";
import { env } from "./env";

// CoinPay HTTP client.
//
// I do not have your CoinPay API reference. The functions below model a
// standard crypto-checkout flow:
//   POST /v1/checkouts → { id, hostedUrl }
//   webhook: x-coinpay-signature = HMAC-SHA256(body, webhook_secret)
//
// When you have the real spec, adjust the path + payload + signature scheme
// in createCheckout / verifyWebhookSignature — nothing else in the codebase
// references CoinPay directly.

export type CreateCheckoutInput = {
  packId: string;
  credits: number;
  amountCents: number;
  ownerId: string;
  ownerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  webhookUrl: string;
  // Echoed back in the webhook payload.
  metadata?: Record<string, string>;
};

export type CreateCheckoutResult = {
  paymentId: string; // CoinPay's id, stored in credit_purchases.coinpay_payment_id
  hostedUrl: string; // where to send the user to pay
};

export async function createCheckout(
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  if (!env.coinpayApiKey || !env.coinpayApiUrl) {
    throw new Error("CoinPay is not configured (COINPAY_API_URL or COINPAY_API_KEY missing).");
  }
  const res = await fetch(`${env.coinpayApiUrl.replace(/\/$/, "")}/v1/checkouts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.coinpayApiKey}`,
      "x-merchant-id": env.coinpayMerchantId,
    },
    body: JSON.stringify({
      merchant_id: env.coinpayMerchantId,
      amount_cents: input.amountCents,
      currency: "USD",
      description: `${input.credits} CrawlProof scan credit${input.credits === 1 ? "" : "s"}`,
      customer_email: input.ownerEmail ?? undefined,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      webhook_url: input.webhookUrl,
      metadata: {
        pack_id: input.packId,
        credits: String(input.credits),
        owner_id: input.ownerId,
        ...input.metadata,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CoinPay createCheckout failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    id?: string;
    payment_id?: string;
    hosted_url?: string;
    url?: string;
  };
  const paymentId = json.id ?? json.payment_id;
  const hostedUrl = json.hosted_url ?? json.url;
  if (!paymentId || !hostedUrl) {
    throw new Error("CoinPay response missing id/hostedUrl.");
  }
  return { paymentId, hostedUrl };
}

// Webhook signature verification. CoinPay should send the raw body and a
// signature header. We default to HMAC-SHA256 hex over the raw body using
// COINPAY_WEBHOOK_SECRET — adjust if the real scheme differs.
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!env.coinpayWebhookSecret || !signature) return false;
  const expected = crypto
    .createHmac("sha256", env.coinpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
