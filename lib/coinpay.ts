import { verifyCoinPayWebhook } from "@profullstack/stack/coinpay";
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
    // payment_method "both" + currency "usdc_pol" is what CoinPay actually
    // accepts for the card path today (raw "card" returns 500). When card
    // is picked, we navigate straight to the returned stripe_checkout_url.
    ...(isCard
      ? { payment_method: "both", currency: "usdc_pol" }
      : { payment_method: "crypto", currency: input.currency }),
    description: descriptionParts.join(" · "),
    // success_url / cancel_url get used verbatim as Stripe Checkout's
    // post-payment URLs (see coinpayportal /api/payments/create:117-118).
    // Omit them and CoinPay defaults to /pay/<id>?status=success on its
    // own portal, stranding the user. redirect_url is the crypto-flow
    // analogue and is honored by CoinPay's hosted pay page only.
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
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

export type CreatePayoutInput = {
  recipientEmail: string;
  recipientWallet: string;
  amountUsd: number;
  currency: string; // upstream expects an upper-case symbol, e.g. "USDC_POL"
};

export type CreatePayoutResult =
  | { ok: true; payoutId: string; status: string; txHash: string | null }
  | { ok: false; error: string; retryable: boolean };

// Send a crypto payout from our CoinPay business wallet to a recipient.
// Hits POST {base}/api/payouts/create (API-key auth = our business). The
// upstream sends on-chain synchronously and returns a payout record.
//
// retryable=true means the request never reached a decision (config/network) so
// the caller can leave the payout queued and try again; retryable=false means
// CoinPay explicitly rejected it (bad address, insufficient funds, …).
export async function createCryptoPayout(
  input: CreatePayoutInput,
): Promise<CreatePayoutResult> {
  if (!env.coinpayApiKey || !env.coinpayApiUrl) {
    return { ok: false, error: "CoinPay is not configured.", retryable: true };
  }
  const base = env.coinpayApiUrl.replace(/\/$/, "");
  const apiUrl = `${base}/api/payouts/create`;

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.coinpayApiKey}`,
      },
      body: JSON.stringify({
        recipient_email: input.recipientEmail,
        recipient_wallet: input.recipientWallet,
        amount_usd: input.amountUsd,
        cryptocurrency: input.currency.toUpperCase(),
        metadata: { source: "crawlproof-ads" },
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `CoinPay payout request failed: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {
      ok: false,
      error: `CoinPay returned non-JSON (${res.status}). Check COINPAY_API_URL.`,
      retryable: true,
    };
  }
  const json = (await res.json()) as {
    success?: boolean;
    error?: string;
    payout?: { id?: string; status?: string; tx_hash?: string | null };
  };

  if (!res.ok || !json.success || !json.payout?.id) {
    return {
      ok: false,
      error: json.error ?? `CoinPay payout failed (${res.status}).`,
      // 5xx / 401 can be retried; explicit 4xx business rejections cannot.
      retryable: res.status >= 500 || res.status === 401,
    };
  }

  return {
    ok: true,
    payoutId: json.payout.id,
    status: json.payout.status ?? "processing",
    txHash: json.payout.tx_hash ?? null,
  };
}

// Verification itself lives in @profullstack/stack/coinpay: HMAC-SHA256 over
// `${t}.${rawBody}` with a 5-minute replay tolerance, constant-time compare,
// and support for multiple `v1=` parts during secret rotation.
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  options: { now?: number; tolerance?: number } = {},
): boolean {
  if (!env.coinpayWebhookSecret) return false;
  return verifyCoinPayWebhook({
    signature: signatureHeader,
    rawBody,
    secret: env.coinpayWebhookSecret,
    now: options.now,
    toleranceSeconds: options.tolerance,
  });
}
