// Ad credit grants for partner platforms (/api/ads/v1/grants).
//
// A partner (ad.network) gives its own users ad credit nobody paid for: a
// credit code, an invite bonus. That credit must run ads the way a deposit
// does, and must never become publisher cash. So a grant lands on the partner
// account as ad_bonus_credits (ad clicks only, spent first, accrues no
// publisher payout: see ad_charge_click), once per (partner, reference),
// through public.ad_partner_grant. Priced at ad value like a deposit:
// $1 = 100 / CREDIT_CENTS credits.

import { depositCredits } from "@/lib/ads/deposits";

export const MAX_GRANT_CENTS = 100_000; // $1,000 per grant

export type GrantRequest = { amountCents: number; credits: number; reference: string };

export function parseGrantRequest(body: Record<string, unknown>): { ok: true; request: GrantRequest } | { ok: false; error: string } {
  const usd = Number(body.amount_usd);
  if (!Number.isFinite(usd)) return { ok: false, error: "amount_usd must be a number." };
  const amountCents = Math.round(usd * 100);
  const credits = depositCredits(amountCents);
  if (credits < 1 || amountCents > MAX_GRANT_CENTS) {
    return { ok: false, error: `amount_usd must be between 0.05 and ${MAX_GRANT_CENTS / 100}.` };
  }
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  if (!/^[\w.@:+-]{1,200}$/.test(reference)) {
    return { ok: false, error: "reference is your id for this grant (1-200 letters, digits or ._@:+-); the same reference grants once." };
  }
  return { ok: true, request: { amountCents, credits, reference } };
}
