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

export type CreatePaymentInput = CreateCheckoutInput & {
  currency: string; // lowercase code, e.g. "usdc_pol", "btc"
};

export type CreatePaymentResult = {
  paymentId: string;
  address: string | null;
  amountCrypto: number | null;
  currency: string;
  expiresAt: string | null;
  hostedUrl: string;
};

export type PaymentStatusResult = {
  paymentId: string;
  status: string;
  amountCrypto: number | null;
  currency: string | null;
  txHash: string | null;
};

type CoinPayPayment = {
  id?: string;
  payment_address?: string;
  amount_crypto?: number | string;
  crypto_amount?: number | string;
  currency?: string;
  expires_at?: string;
  stripe_checkout_url?: string;
  status?: string;
  tx_hash?: string;
};

type CoinPayResponse = {
  success?: boolean;
  payment?: CoinPayPayment;
  error?: string;
};

export async function createCheckout(
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  if (!env.coinpayApiKey || !env.coinpayApiUrl || !env.coinpayMerchantId) {
    throw new Error("CoinPay is not configured (COINPAY_API_URL/KEY/MERCHANT_ID).");
  }

  // CoinPay API surface (per docs at https://coinpayportal.com/docs):
  //   POST {COINPAY_API_URL}/api/payments/create   — create the payment
  //   GET  {COINPAY_API_URL}/pay/{payment_id}      — customer-facing hosted page
  // payment_method "both" gives the customer crypto + Stripe Checkout tabs.
  // metadata.purchase_id is encoded in `description` since the API doesn't
  // document a separate metadata passthrough — we match webhooks by payment_id.
  const base = env.coinpayApiUrl.replace(/\/$/, "");
  const apiUrl = `${base}/api/payments/create`;
  const descriptionParts = [
    `${input.credits} CrawlProof scan credit${input.credits === 1 ? "" : "s"}`,
  ];
  if (input.metadata?.purchase_id) {
    descriptionParts.push(`purchase=${input.metadata.purchase_id}`);
  }

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.coinpayApiKey}`,
    },
    body: JSON.stringify({
      business_id: env.coinpayMerchantId,
      amount_usd: Number((input.amountCents / 100).toFixed(2)),
      currency: "usdc_pol", // low-fee default; customer picks chain on the hosted page
      payment_method: "crypto", // card requires Stripe Connect onboarding — we don't support it
      description: descriptionParts.join(" · "),
      redirect_url: input.successUrl,
    }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint =
      !isJson && body.trim().startsWith("<")
        ? " (got HTML — endpoint wrong; check COINPAY_API_URL)"
        : "";
    throw new Error(
      `CoinPay createCheckout failed: ${res.status} ${res.statusText}${hint}. Tried ${apiUrl}. ${body.slice(0, 200)}`,
    );
  }
  if (!isJson) {
    throw new Error(
      `CoinPay returned non-JSON (${contentType}). Check COINPAY_API_URL.`,
    );
  }

  const json = (await res.json()) as CoinPayResponse;
  const payment = json.payment;
  if (!payment?.id) {
    throw new Error(
      `CoinPay response missing payment.id: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  // Customer-facing checkout — combines crypto QR + Stripe tabs (since
  // payment_method=both).
  const hostedUrl = `${base}/pay/${payment.id}`;
  return { paymentId: payment.id, hostedUrl };
}

// Currency-aware payment creation — used by the in-app modal flow so the
// user picks a coin without ever leaving the site. Returns the address,
// amount_crypto, and expires_at so the client can render a QR code and
// poll for confirmation.
export async function createPayment(
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  if (!env.coinpayApiKey || !env.coinpayApiUrl || !env.coinpayMerchantId) {
    throw new Error("CoinPay is not configured (COINPAY_API_URL/KEY/MERCHANT_ID).");
  }
  const base = env.coinpayApiUrl.replace(/\/$/, "");
  const apiUrl = `${base}/api/payments/create`;
  const descriptionParts = [
    `${input.credits} CrawlProof scan credit${input.credits === 1 ? "" : "s"}`,
  ];
  if (input.metadata?.purchase_id) {
    descriptionParts.push(`purchase=${input.metadata.purchase_id}`);
  }
  const isCard = input.currency === "card";
  const body = {
    business_id: env.coinpayMerchantId,
    amount_usd: Number((input.amountCents / 100).toFixed(2)),
    // For card we still set a fallback crypto currency (CoinPay requires
    // one) and ask for `both` so the customer gets the Stripe option.
    ...(isCard
      ? { payment_method: "both", currency: "usdc_pol" }
      : { payment_method: "crypto", currency: input.currency }),
    description: descriptionParts.join(" · "),
    redirect_url: input.successUrl,
  };
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.coinpayApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CoinPay createPayment failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as CoinPayResponse;
  const payment = json.payment;
  if (!payment?.id) {
    throw new Error(`CoinPay response missing payment.id: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const amountCrypto =
    typeof payment.amount_crypto !== "undefined"
      ? Number(payment.amount_crypto)
      : typeof payment.crypto_amount !== "undefined"
        ? Number(payment.crypto_amount)
        : null;
  return {
    paymentId: payment.id,
    address: payment.payment_address ?? null,
    amountCrypto: Number.isFinite(amountCrypto) ? amountCrypto : null,
    currency: payment.currency ?? input.currency,
    expiresAt: payment.expires_at ?? null,
    hostedUrl: payment.stripe_checkout_url ?? `${base}/pay/${payment.id}`,
  };
}

// Poll-target. Returns the public payment view; status drives the modal's
// state machine on the client.
export async function getPaymentStatus(
  paymentId: string,
): Promise<PaymentStatusResult | null> {
  if (!env.coinpayApiUrl) return null;
  const base = env.coinpayApiUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/payments/${paymentId}`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as CoinPayResponse & { payment?: CoinPayPayment };
  const p = json.payment;
  if (!p?.id) return null;
  const amountCrypto =
    typeof p.amount_crypto !== "undefined"
      ? Number(p.amount_crypto)
      : typeof p.crypto_amount !== "undefined"
        ? Number(p.crypto_amount)
        : null;
  return {
    paymentId: p.id,
    status: p.status ?? "pending",
    amountCrypto: Number.isFinite(amountCrypto) ? amountCrypto : null,
    currency: p.currency ?? null,
    txHash: p.tx_hash ?? null,
  };
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

function hmac(secret: string | Buffer, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// CoinPay's webhook secret is "whsecret_<64 hex chars>" — the hex is a 32-byte
// key. We don't know which form they HMAC with, so we try them all.
function secretCandidates(raw: string): Array<[string, string | Buffer]> {
  const candidates: Array<[string, string | Buffer]> = [];
  candidates.push(["raw_utf8", raw]);
  const m = raw.match(/^whsecret_([0-9a-f]+)$/i);
  if (m) {
    candidates.push(["hex_string", m[1]]);
    if (m[1].length % 2 === 0) {
      try {
        candidates.push(["hex_decoded", Buffer.from(m[1], "hex")]);
      } catch {
        /* skip */
      }
    }
  }
  return candidates;
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
  const secrets = secretCandidates(env.coinpayWebhookSecret);

  for (const [sLabel, secret] of secrets) {
    for (const [mLabel, message] of variants) {
      const expected = hmac(secret, message);
      if (parsed.v1.some((cand) => eqTimingSafe(cand, expected))) {
        if (sLabel !== "raw_utf8" || mLabel !== "t.body") {
          console.warn(
            `[coinpay] verify OK via secret=${sLabel}, signing=${mLabel}`,
          );
        }
        return true;
      }
    }
  }

  // None matched — log enough to compare with the sender. No secret leak.
  console.warn("[coinpay] verify FAIL", {
    bodyLen: rawBody.length,
    ts: parsed.t,
    v1_tail: parsed.v1.map((s) => s.slice(-8)),
    secret_len: env.coinpayWebhookSecret.length,
    tails: Object.fromEntries(
      secrets.flatMap(([sLabel, secret]) =>
        variants.map(([mLabel, message]) => [
          `${sLabel}:${mLabel}`,
          hmac(secret, message).slice(-8),
        ]),
      ),
    ),
  });
  return false;
}
