// Ad-budget deposits for partner platforms (/api/ads/v1/deposits).
//
// A partner is a front door that runs campaigns for its own users from one
// crawlproof account, such as ad.network (https://ad.network.pit.world). Its
// users think in dollars of ad budget, not in scan packs, so a deposit buys
// credits at their ad value: $1 = 100 / CREDIT_CENTS credits. That is below the
// scan price in lib/credits.ts, which is why only listed accounts may use it:
// credits are one balance, and an open face-value route would sell scans at
// a sixth of their price. Cash still sits behind every credit (5c in, at most
// 1.4c out to a publisher), well above MIN_CASH_PER_CREDIT_CENTS.
//
// The purchase is an ordinary credit_purchases row (pack_id "ad-budget") on a
// CoinPay checkout session, so the webhook, the status poll and the receipt
// all work unchanged. payment_id in the answer is the cs_ session id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CREDIT_CENTS } from "@/lib/ads/pricing";
import { getPaymentStatus, selectSessionMethod } from "@/lib/coinpay";
import { adBudgetDescription, openPurchaseCheckout } from "@/lib/credits-checkout";

export const AD_BUDGET_PACK = "ad-budget";
export const MIN_DEPOSIT_CENTS = 500;
export const MAX_DEPOSIT_CENTS = 1_000_000;

// Read per request under a computed name: Next.js inlines a literal
// process.env.NAME at build time, which would freeze the list into the image.
const PARTNER_VAR = "ADS_PARTNER_USER_IDS";

export function partnerUserIds(raw = process.env[PARTNER_VAR]): Set<string> {
  return new Set(String(raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

export function isAdsPartner(userId: string, raw?: string): boolean {
  return partnerUserIds(raw).has(userId);
}

/**
 * checkout "session" (partners that redirect the buyer): answer the hosted
 * CoinPay checkout URL, where the buyer picks any coin or PayPal. The buyer's
 * own email and the partner's id for them go on the session, with the
 * partner's hostname as property and its return URLs.
 * checkout "coin" (default, older callers): pre-pick `currency` and answer the
 * address + exact amount for the partner to render.
 */
export type DepositRequest = {
  amountCents: number;
  currency: string;
  checkout: "coin" | "session";
  customerEmail?: string;
  accountId?: string;
  property?: string;
  successUrl?: string;
  cancelUrl?: string;
};

const EMAIL_RE = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,190}\.[a-z0-9-]{2,63}$/i;
const HOST_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A partner return URL: https only, at most 500 chars. */
export function cleanReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  // {CHECKOUT_SESSION_ID} is CoinPay's placeholder; URL() would escape the braces.
  const probe = raw.replace(/\{CHECKOUT_SESSION_ID\}/g, "cs_placeholder");
  try {
    const u = new URL(probe);
    return u.protocol === "https:" && u.hostname ? raw : null;
  } catch {
    return null;
  }
}

/** A site hostname for CoinPay's property: a bare host, or the host of a URL. */
export function cleanProperty(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (host.includes("/")) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      return null;
    }
  }
  return HOST_RE.test(host) ? host : null;
}

export function parseDepositRequest(body: Record<string, unknown>): { ok: true; request: DepositRequest } | { ok: false; error: string } {
  const usd = Number(body.amount_usd);
  if (!Number.isFinite(usd)) return { ok: false, error: "amount_usd must be a number." };
  const amountCents = Math.round(usd * 100);
  if (amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
    return { ok: false, error: `amount_usd must be between ${MIN_DEPOSIT_CENTS / 100} and ${MAX_DEPOSIT_CENTS / 100}.` };
  }
  const currency = String(body.currency ?? "usdc_pol").trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(currency)) return { ok: false, error: "currency is a CoinPay coin id, e.g. usdc_pol, usdc_sol, btc, eth." };
  const checkout = String(body.checkout ?? "coin").trim().toLowerCase();
  if (checkout !== "coin" && checkout !== "session") return { ok: false, error: "checkout is 'session' (hosted CoinPay page) or 'coin' (address + amount)." };
  if (checkout === "coin") return { ok: true, request: { amountCents, currency, checkout } };

  const request: DepositRequest = { amountCents, currency, checkout };
  if (body.customer_email != null && body.customer_email !== "") {
    const email = String(body.customer_email).trim();
    if (!EMAIL_RE.test(email)) return { ok: false, error: "customer_email must be an email address." };
    request.customerEmail = email;
  }
  if (body.account_id != null && body.account_id !== "") {
    const id = String(body.account_id).trim();
    if (!/^[\w.@:+-]{1,200}$/.test(id)) return { ok: false, error: "account_id is up to 200 letters, digits or ._@:+-" };
    request.accountId = id;
  }
  if (body.property != null && body.property !== "") {
    const property = cleanProperty(body.property);
    if (!property) return { ok: false, error: "property must be a hostname, e.g. ad.network.pit.world." };
    request.property = property;
  }
  for (const [key, field] of [["success_url", "successUrl"], ["cancel_url", "cancelUrl"]] as const) {
    if (body[key] == null || body[key] === "") continue;
    const url = cleanReturnUrl(body[key]);
    if (!url) return { ok: false, error: `${key} must be an https URL.` };
    request[field] = url;
  }
  return { ok: true, request };
}

/** Credits a deposit buys at ad value. */
export const depositCredits = (amountCents: number) => Math.floor(amountCents / CREDIT_CENTS);

export type DepositInvoice = {
  payment_id: string;
  amount_usd: number;
  credits: number;
  currency: string;
  address: string | null;
  amount_crypto: string | null;
  expires_at: string | null;
  checkout_url: string | null;
  status: "pending";
};

export type DepositSession = {
  checkout_session_id: string;
  /** Same id, under the name the status route and older callers use. */
  payment_id: string;
  url: string;
  checkout_url: string;
  amount_usd: number;
  credits: number;
  methods: string[];
  expires_at: string | null;
  status: "open";
};

export async function createAdDeposit(input: {
  sb: SupabaseClient;
  userId: string;
  email: string | null;
  request: DepositRequest;
  reference?: string;
}): Promise<{ ok: true; deposit: DepositInvoice | DepositSession } | { ok: false; status: number; error: string }> {
  const { sb, userId, request } = input;
  const credits = depositCredits(request.amountCents);
  const { data: purchase, error } = await sb
    .from("credit_purchases")
    .insert({ owner_id: userId, pack_id: AD_BUDGET_PACK, credits_added: credits, amount_cents: request.amountCents, currency: "USD", status: "pending" })
    .select("id")
    .single();
  if (error || !purchase) return { ok: false, status: 500, error: error?.message ?? "Could not record the deposit." };

  try {
    const session = await openPurchaseCheckout({
      sb,
      purchaseId: purchase.id,
      userId,
      email: input.email,
      packId: AD_BUDGET_PACK,
      credits,
      amountCents: request.amountCents,
      description: adBudgetDescription(request.amountCents),
      kind: "ad_budget",
      ...(input.reference ? { reference: input.reference } : {}),
      ...(request.checkout === "session"
        ? {
            partner: {
              customerEmail: request.customerEmail,
              accountId: request.accountId,
              property: request.property,
              successUrl: request.successUrl,
              cancelUrl: request.cancelUrl,
            },
          }
        : {}),
    });
    if (request.checkout === "session") {
      return {
        ok: true,
        deposit: {
          checkout_session_id: session.sessionId,
          payment_id: session.sessionId,
          url: session.url,
          checkout_url: session.url,
          amount_usd: request.amountCents / 100,
          credits,
          methods: session.methods,
          expires_at: session.expiresAt,
          status: "open",
        },
      };
    }
    // Partners render their own address + QR, so pre-pick the coin they asked
    // for on the session. If CoinPay will not open it, the deposit still works
    // through checkout_url, where the buyer can also pick another coin or PayPal.
    const paymentId = await selectSessionMethod(session.sessionId, request.currency);
    const payment = paymentId ? await getPaymentStatus(paymentId).catch(() => null) : null;
    return {
      ok: true,
      deposit: {
        payment_id: session.sessionId,
        amount_usd: request.amountCents / 100,
        credits,
        currency: request.currency,
        address: payment?.address ?? null,
        amount_crypto: payment?.amountCrypto == null ? null : String(payment.amountCrypto),
        expires_at: payment?.expiresAt ?? session.expiresAt,
        checkout_url: session.url,
        status: "pending",
      },
    };
  } catch (err) {
    await sb.from("credit_purchases").update({ status: "failed" }).eq("id", purchase.id);
    return { ok: false, status: 502, error: err instanceof Error ? err.message : "CoinPay error." };
  }
}
