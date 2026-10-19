// Publisher withdrawals, shared by the dashboard's server action and the
// bearer-token API (/api/ads/v1/slots/[id]/payout).
//
// A withdrawal takes everything a slot has accrued and not yet withdrawn, and
// sends it to that slot's payout wallet through CoinPay. Callers pass a
// service-role client and the user id they authenticated: every read and write
// here is scoped by owner_id explicitly, because the service client skips RLS.

import type { SupabaseClient } from "@supabase/supabase-js";
import { MIN_PAYOUT_CENTS } from "@/lib/ads/pricing";
import { createCryptoPayout } from "@/lib/coinpay";

export type PayoutResult =
  | { ok: true; amountCents: number; status: "confirmed" | "sent" | "requested" }
  | { ok: false; error: string };

/** What a slot has accrued, minus every withdrawal that has not failed. */
export async function slotAvailableCents(sb: SupabaseClient, slotId: string): Promise<number> {
  const [{ data: accruals }, { data: payouts }] = await Promise.all([
    sb.from("ad_ledger").select("amount_cents").eq("slot_id", slotId).eq("kind", "publisher_accrual"),
    sb.from("ad_payouts").select("amount_cents, status").eq("slot_id", slotId),
  ]);
  const earned = (accruals ?? []).reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const withdrawn = (payouts ?? [])
    .filter((p) => p.status !== "failed")
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  return earned - withdrawn;
}

/** Clean a payout wallet for storage: trimmed, capped, lowercased coin; empty clears it. */
export function cleanPayoutTarget(address: unknown, currency: unknown): { address: string | null; currency: string | null } {
  const a = String(address ?? "").trim().slice(0, 200);
  const c = String(currency ?? "").trim().toLowerCase().slice(0, 20);
  return { address: a || null, currency: c || null };
}

export async function requestSlotPayout(input: {
  sb: SupabaseClient;
  userId: string;
  email: string | null;
  slotId: string;
}): Promise<PayoutResult> {
  const { sb, userId, slotId } = input;
  const { data: slot } = await sb
    .from("ad_slots")
    .select("id, payout_address, payout_currency")
    .eq("id", slotId)
    .eq("owner_id", userId)
    .maybeSingle();
  if (!slot) return { ok: false, error: "Slot not found." };
  if (!slot.payout_address) return { ok: false, error: "Add a payout wallet address first." };

  const available = await slotAvailableCents(sb, slotId);
  if (available < MIN_PAYOUT_CENTS) {
    return { ok: false, error: `Minimum withdrawal is ${(MIN_PAYOUT_CENTS / 100).toFixed(2)}. You have ${(available / 100).toFixed(2)}.` };
  }

  // Solvency backstop: cumulative publisher payouts can never exceed cumulative
  // real advertiser cash in. The floor-rate math already guarantees this per
  // click; this is belt-and-braces against pricing/promo misconfiguration.
  const [{ data: deposits }, { data: allPayouts }] = await Promise.all([
    sb.from("credit_purchases").select("amount_cents").eq("status", "complete"),
    sb.from("ad_payouts").select("amount_cents, status"),
  ]);
  const cashIn = (deposits ?? []).reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const paidOut = (allPayouts ?? [])
    .filter((p) => p.status !== "failed")
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  if (paidOut + available > cashIn) {
    return { ok: false, error: "Withdrawals are briefly paused for reconciliation. Please try again later." };
  }

  const currency = slot.payout_currency || "usdc_pol";
  const { data: payout, error } = await sb
    .from("ad_payouts")
    .insert({ owner_id: userId, slot_id: slotId, amount_cents: available, currency, address: slot.payout_address, status: "requested" })
    .select("id")
    .single();
  if (error || !payout) return { ok: false, error: error?.message ?? "Failed to record payout." };

  // Execute the on-chain transfer via CoinPay's payout API. On an explicit
  // rejection we mark the payout failed (which frees the balance to retry). On
  // a transient/config error we leave it 'requested' so it can be processed
  // later without double-paying.
  const result = await createCryptoPayout({
    recipientEmail: input.email ?? `${userId}@users.crawlproof.com`,
    recipientWallet: slot.payout_address,
    amountUsd: available / 100,
    currency,
  });

  if (result.ok) {
    const settled = result.status === "completed";
    await sb
      .from("ad_payouts")
      .update({
        status: settled ? "confirmed" : "sent",
        coinpay_payout_id: result.payoutId,
        tx_hash: result.txHash,
        settled_at: settled ? new Date().toISOString() : null,
      })
      .eq("id", payout.id);
    await sb.from("ad_ledger").insert({
      kind: "publisher_payout",
      owner_id: userId,
      slot_id: slotId,
      amount_cents: -available,
      currency,
      coinpay_payment_id: result.payoutId,
      tx_hash: result.txHash,
    });
    return { ok: true, amountCents: available, status: settled ? "confirmed" : "sent" };
  }

  if (!result.retryable) {
    await sb.from("ad_payouts").update({ status: "failed" }).eq("id", payout.id);
    return { ok: false, error: result.error };
  }

  // Transient: keep the request queued (counts against the balance) and report.
  return { ok: true, amountCents: available, status: "requested" };
}
