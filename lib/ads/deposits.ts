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
// The purchase is an ordinary credit_purchases row (pack_id "ad-budget"), so
// the CoinPay webhook, the status poll and the receipt all work unchanged.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CREDIT_CENTS } from "@/lib/ads/pricing";
import { createPayment } from "@/lib/coinpay";
import { env } from "@/lib/env";

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

export type DepositRequest = { amountCents: number; currency: string };

export function parseDepositRequest(body: Record<string, unknown>): { ok: true; request: DepositRequest } | { ok: false; error: string } {
  const usd = Number(body.amount_usd);
  if (!Number.isFinite(usd)) return { ok: false, error: "amount_usd must be a number." };
  const amountCents = Math.round(usd * 100);
  if (amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
    return { ok: false, error: `amount_usd must be between ${MIN_DEPOSIT_CENTS / 100} and ${MAX_DEPOSIT_CENTS / 100}.` };
  }
  const currency = String(body.currency ?? "usdc_pol").trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(currency)) return { ok: false, error: "currency is a CoinPay coin id, e.g. usdc_pol, usdc_sol, btc, eth." };
  return { ok: true, request: { amountCents, currency } };
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

export async function createAdDeposit(input: {
  sb: SupabaseClient;
  userId: string;
  email: string | null;
  request: DepositRequest;
  reference?: string;
}): Promise<{ ok: true; deposit: DepositInvoice } | { ok: false; status: number; error: string }> {
  const { sb, userId, request } = input;
  const credits = depositCredits(request.amountCents);
  const { data: purchase, error } = await sb
    .from("credit_purchases")
    .insert({ owner_id: userId, pack_id: AD_BUDGET_PACK, credits_added: credits, amount_cents: request.amountCents, currency: "USD", status: "pending" })
    .select("id")
    .single();
  if (error || !purchase) return { ok: false, status: 500, error: error?.message ?? "Could not record the deposit." };

  const site = (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");
  try {
    const payment = await createPayment({
      packId: AD_BUDGET_PACK,
      credits,
      amountCents: request.amountCents,
      ownerId: userId,
      ownerEmail: input.email,
      currency: request.currency,
      successUrl: `${site}/dashboard/settings/billing?purchase=success`,
      cancelUrl: `${site}/dashboard/settings/billing?purchase=cancel`,
      webhookUrl: `${site}/api/coinpay/webhook`,
      metadata: { purchase_id: purchase.id, ...(input.reference ? { reference: input.reference.slice(0, 120) } : {}) },
    });
    await sb.from("credit_purchases").update({ coinpay_payment_id: payment.paymentId }).eq("id", purchase.id);
    return {
      ok: true,
      deposit: {
        payment_id: payment.paymentId,
        amount_usd: request.amountCents / 100,
        credits,
        currency: payment.currency,
        address: payment.address,
        amount_crypto: payment.amountCrypto === null ? null : String(payment.amountCrypto),
        expires_at: payment.expiresAt,
        checkout_url: payment.hostedUrl,
        status: "pending",
      },
    };
  } catch (err) {
    await sb.from("credit_purchases").update({ status: "failed" }).eq("id", purchase.id);
    return { ok: false, status: 502, error: err instanceof Error ? err.message : "CoinPay error." };
  }
}
