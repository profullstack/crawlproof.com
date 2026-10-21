import { verifyCoinPayWebhook } from "@profullstack/stack/coinpay";
import { env } from "./env";

// CoinPay HTTP client.
//
// Every purchase (scan credit packs, partner ad-budget deposits) opens a CoinPay
// hosted checkout session: POST {base}/api/checkout/sessions. The buyer lands
// on CoinPay's page and picks any coin the business holds a wallet for, or
// PayPal. The session carries customer_email, account_id (the crawlproof user
// id), property and our metadata (purchase_id), and CoinPay echoes all of it on
// every webhook as data.checkout_session_id / account_id / metadata.
//
// The cs_ session id is stored in credit_purchases.coinpay_payment_id, so the
// completion RPC, receipts, affiliate conversions and the deposit bonus all key
// on it unchanged. Purchases opened before sessions keep their raw payment id
// there and still settle by data.payment_id.
//
// Webhook signature format (Stripe-style):
//
//   X-CoinPay-Signature: t=<unix-timestamp>,v1=<hex hmac-sha256>
//
// where v1 = HMAC-SHA256(`${t}.${rawBody}`, COINPAY_WEBHOOK_SECRET).
// Multiple `v1=` parts are allowed during secret rotation; any match is OK.

/** Sent as `property` on every session so CoinPay rows map back to this site. */
export const PAYMENT_PROPERTY = "crawlproof.com";
export const CHECKOUT_WINDOW_MINUTES = 60;

export function isSessionId(id: string | null | undefined): boolean {
  return typeof id === "string" && /^cs_[A-Za-z0-9]{8,64}$/.test(id);
}

function coinpayBase(): string {
  // COINPAY_API_URL has been set both with and without a trailing /api.
  return env.coinpayApiUrl.replace(/\/+$/, "").replace(/\/api$/, "");
}

function requireConfig(): void {
  if (!env.coinpayApiKey || !env.coinpayApiUrl) {
    throw new Error("CoinPay is not configured (COINPAY_API_URL/KEY).");
  }
}

export type CreateSessionInput = {
  amountCents: number;
  description: string;
  customerEmail: string;
  accountId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  /** Site hostname shown on CoinPay rows; partners pass their own (ad.network.pit.world). */
  property?: string;
};

export type CreateSessionResult = {
  sessionId: string;
  url: string;
  expiresAt: string | null;
  methods: string[];
};

/** The body CoinPay gets for a session; exported for tests. */
export function checkoutSessionBody(input: CreateSessionInput): Record<string, unknown> {
  return {
    amount: Number((input.amountCents / 100).toFixed(2)),
    currency: "USD",
    description: input.description,
    customer_email: input.customerEmail,
    account_id: input.accountId,
    property: input.property || PAYMENT_PROPERTY,
    metadata: { property: input.property || PAYMENT_PROPERTY, ...input.metadata },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_in_minutes: CHECKOUT_WINDOW_MINUTES,
  };
}

export async function createCheckoutSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  requireConfig();
  if (!input.customerEmail) throw new Error("An email address is required to check out.");
  const base = coinpayBase();
  const apiUrl = `${base}/api/checkout/sessions`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.coinpayApiKey}`,
    },
    body: JSON.stringify(checkoutSessionBody(input)),
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  if (!isJson) {
    throw new Error(`CoinPay returned non-JSON (${res.status}) from ${apiUrl}. Check COINPAY_API_URL.`);
  }
  const json = (await res.json()) as {
    id?: string;
    url?: string;
    expires_at?: string;
    methods?: unknown[];
    error?: string;
    code?: string;
  };
  if (!res.ok || !json.id || !json.url) {
    throw new Error(
      `CoinPay checkout session failed ${res.status}: ${json.code ?? ""} ${json.error ?? ""}`.trim(),
    );
  }
  if (!isSessionId(json.id)) throw new Error("CoinPay returned an unexpected session id.");
  // Only ever send buyers to CoinPay's own origin.
  const origin = new URL(base).origin;
  const u = new URL(json.url, origin);
  if (u.origin !== origin) throw new Error("CoinPay returned a checkout URL on another origin.");
  const methods = (json.methods ?? [])
    .map((m) => (typeof m === "string" ? m : String((m as { code?: string })?.code ?? "")))
    .filter(Boolean);
  return { sessionId: json.id, url: u.toString(), expiresAt: json.expires_at ?? null, methods };
}

/**
 * Pre-pick a coin on a session (partners that render their own address + QR).
 * Answers the underlying payment id, or null if CoinPay would not open it; the
 * session URL still works then, so the caller degrades to the hosted page.
 */
export async function selectSessionMethod(sessionId: string, method: string): Promise<string | null> {
  if (!isSessionId(sessionId)) return null;
  try {
    const res = await fetch(`${coinpayBase()}/api/checkout/sessions/${sessionId}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: method.toUpperCase() }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { payment_id?: string };
    return json.payment_id ? String(json.payment_id) : null;
  } catch {
    return null;
  }
}

export type SessionStatusResult = {
  sessionId: string;
  status: "open" | "paid" | "expired" | string;
  paymentId: string | null;
  paidMethod: string | null;
};

/** Owner view of a session (with our key): status and the payment behind it. */
export async function getCheckoutSession(sessionId: string): Promise<SessionStatusResult | null> {
  if (!isSessionId(sessionId) || !env.coinpayApiUrl) return null;
  const res = await fetch(`${coinpayBase()}/api/checkout/sessions/${sessionId}`, {
    headers: env.coinpayApiKey ? { authorization: `Bearer ${env.coinpayApiKey}` } : {},
    cache: "no-store",
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as {
    session?: { id?: string; status?: string; payment_id?: string | null; paid_method?: string | null };
  };
  const s = json.session;
  if (!s?.id) return null;
  return {
    sessionId: s.id,
    status: String(s.status ?? "open"),
    paymentId: s.payment_id ?? null,
    paidMethod: s.paid_method ?? null,
  };
}

export type CoinpayWebhookEvent = {
  eventType: string;
  paymentId: string | null;
  status: string;
  sessionId: string | null;
  accountId: string | null;
  metadata: Record<string, unknown>;
  txHash: string | null;
};

/**
 * CoinPay nests the payment under `data`; the top-level `id` is the EVENT id,
 * never the payment. Read `data` first and fall back to a flat body (the older
 * test sender).
 */
export function readCoinpayWebhook(payload: unknown): CoinpayWebhookEvent {
  const p = (payload ?? {}) as Record<string, unknown>;
  const nested = p.data && typeof p.data === "object";
  const d = (nested ? p.data : p) as Record<string, unknown>;
  const meta = ((d.metadata ?? p.metadata) as Record<string, unknown> | undefined) ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const sessionId = str(d.checkout_session_id) ?? str(meta.checkout_session_id);
  return {
    eventType: String(p.type ?? p.event ?? "").toLowerCase(),
    paymentId: str(d.payment_id) ?? (nested ? str(d.id) : null),
    status: String(d.status ?? "").toLowerCase(),
    sessionId: isSessionId(sessionId) ? sessionId : null,
    accountId: str(d.account_id) ?? str(meta.account_id),
    metadata: meta,
    txHash: str(d.tx_hash),
  };
}

export type PaymentStatusResult = {
  paymentId: string;
  status: string;
  amountCrypto: number | null;
  currency: string | null;
  address: string | null;
  expiresAt: string | null;
  txHash: string | null;
};

type CoinPayPayment = {
  id?: string;
  payment_address?: string;
  amount_crypto?: number | string;
  crypto_amount?: number | string;
  currency?: string;
  blockchain?: string;
  expires_at?: string;
  status?: string;
  tx_hash?: string;
};

// The public payment view: status for purchases opened before sessions, and the
// address + amount a partner renders after selectSessionMethod.
export async function getPaymentStatus(
  paymentId: string,
): Promise<PaymentStatusResult | null> {
  if (!env.coinpayApiUrl) return null;
  const res = await fetch(`${coinpayBase()}/api/payments/${encodeURIComponent(paymentId)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as { payment?: CoinPayPayment };
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
    currency: p.blockchain ?? p.currency ?? null,
    address: p.payment_address ?? null,
    expiresAt: p.expires_at ?? null,
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
