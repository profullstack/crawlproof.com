import crypto from "node:crypto";
import { env } from "./env";

// CoinPay HTTP client.
//
// Webhook signature format (Stripe-style):
//
//   X-CoinPay-Signature: t=<unix-timestamp>,v1=<hex hmac-sha256>
//
// where v1 = HMAC-SHA256(`${t}.${rawBody}`, COINPAY_WEBHOOK_SECRET).
// Multiple `v1=` parts are allowed during secret rotation — any match is OK.

export type CreateCheckoutInput = {
  packId: string;
  credits: number;
  amountCents: number;
  ownerId: string;
  ownerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  webhookUrl: string;
  metadata?: Record<string, string>;
};

export type CreateCheckoutResult = {
  paymentId: string;
  hostedUrl: string;
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

// Parse the Stripe-style `t=...,v1=...` header into its parts.
function parseSignatureHeader(header: string): { t: string; v1: string[] } | null {
  const t: string[] = [];
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (!k || v === undefined) continue;
    if (k.trim() === "t") t.push(v.trim());
    else if (k.trim() === "v1") v1.push(v.trim());
  }
  if (t.length !== 1 || v1.length === 0) return null;
  return { t: t[0], v1 };
}

// Reject signatures older than this window to limit replay attacks.
const TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: { now?: number; tolerance?: number } = {},
): boolean {
  if (!env.coinpayWebhookSecret || !signatureHeader) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const ts = Number.parseInt(parsed.t, 10);
  if (!Number.isFinite(ts)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.tolerance ?? TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return false;

  const expected = crypto
    .createHmac("sha256", env.coinpayWebhookSecret)
    .update(`${parsed.t}.${rawBody}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return parsed.v1.some((candidate) => {
    const candBuf = Buffer.from(candidate, "utf8");
    if (candBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(candBuf, expectedBuf);
  });
}
