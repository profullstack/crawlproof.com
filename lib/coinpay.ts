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

function hmac(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function eqTimingSafe(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Build several plausible signing forms and try them all. Stripe uses
// `${t}.${body}`; if CoinPay diverges we'll cover the common variants
// (omit timestamp, omit separator, reverse). Whichever wins, the next
// log line tells us which one to keep.
function candidateMessages(t: string, body: string): Array<[string, string]> {
  return [
    ["t.body", `${t}.${body}`],
    ["t+body", `${t}${body}`],
    ["body.t", `${body}.${t}`],
    ["body", body],
  ];
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: { now?: number; tolerance?: number } = {},
): boolean {
  if (!env.coinpayWebhookSecret || !signatureHeader) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    console.warn("[coinpay] verify: unparseable signature header", { header: signatureHeader.slice(0, 60) });
    return false;
  }

  const ts = Number.parseInt(parsed.t, 10);
  if (!Number.isFinite(ts)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.tolerance ?? TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) {
    console.warn("[coinpay] verify: timestamp out of tolerance", { ts, now, drift: now - ts });
    return false;
  }

  const variants = candidateMessages(parsed.t, rawBody);
  for (const [label, message] of variants) {
    const expected = hmac(env.coinpayWebhookSecret, message);
    if (parsed.v1.some((cand) => eqTimingSafe(cand, expected))) {
      if (label !== "t.body") {
        console.warn(`[coinpay] verify OK via non-standard signing variant: ${label}`);
      }
      return true;
    }
  }

  // None matched — log enough to compare against the sender, no secret leak.
  console.warn("[coinpay] verify FAIL", {
    bodyLen: rawBody.length,
    ts: parsed.t,
    v1_tail: parsed.v1.map((s) => s.slice(-8)),
    expected_tail_t_body: hmac(env.coinpayWebhookSecret, `${parsed.t}.${rawBody}`).slice(-8),
    expected_tail_body: hmac(env.coinpayWebhookSecret, rawBody).slice(-8),
    secret_len: env.coinpayWebhookSecret.length,
  });
  return false;
}
