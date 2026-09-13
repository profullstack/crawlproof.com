// Paying an affiliate: approved conversions → one payout row → CoinPay. The
// RPC debits first (conversions flip to paid), CoinPay sends second, and a
// failed send puts them back, so money is delayed by an outage but never
// sent twice.

import { serviceClient } from "../supabase/service";
import { createCryptoPayout } from "../coinpay";
import { PAYOUT_COINPAY_CURRENCY, PAYOUT_METHOD, PAYOUT_MIN_CENTS } from "./program";
import { walletOf, isPayAddress } from "./spec";
import { membershipById, type Membership } from "./memberships";
import { queueEvent } from "./webhooks";

type Svc = ReturnType<typeof serviceClient>;

export type PayoutOutcome =
  | { ok: true; payoutId: string; amountCents: number; txHash: string | null; status: string }
  | { ok: false; error: string };

export async function requestPayout(membership: Membership, opts: { minCents?: number } = {}): Promise<PayoutOutcome> {
  if (membership.status !== "active") return { ok: false, error: "This membership is not active." };
  if (!membership.payAddress || !isPayAddress(membership.payAddress)) {
    return { ok: false, error: "Set a payout address first: an EVM address, paid in USDC on Polygon." };
  }
  const svc = serviceClient();
  const { data, error } = await svc.rpc("affiliate_request_payout", {
    p_membership: membership.id,
    p_method: PAYOUT_METHOD,
    p_address: membership.payAddress,
    p_min_cents: opts.minCents ?? PAYOUT_MIN_CENTS,
  });
  if (error) return { ok: false, error: error.message.replace(/^affiliate_request_payout:\s*/, "") };
  const row = (Array.isArray(data) ? data[0] : data) as { payout_id: string; amount_cents: number } | undefined;
  if (!row?.payout_id) return { ok: false, error: "Nothing approved to pay." };

  const sent = await createCryptoPayout({
    recipientEmail: membership.email ?? `affiliate+${membership.code}@crawlproof.com`,
    recipientWallet: walletOf(membership.payAddress),
    amountUsd: row.amount_cents / 100,
    currency: PAYOUT_COINPAY_CURRENCY,
  });
  if (!sent.ok) {
    await svc.rpc("affiliate_fail_payout", { p_payout: row.payout_id, p_error: sent.error });
    return { ok: false, error: sent.error };
  }
  await svc
    .from("affiliate_payouts")
    .update({ status: "sent", coinpay_payout_id: sent.payoutId, tx_hash: sent.txHash, settled_at: new Date().toISOString() })
    .eq("id", row.payout_id);
  await queueEvent(membership, "payout.sent", {
    payout: { id: row.payout_id, amount: row.amount_cents / 100, method: PAYOUT_METHOD, tx: sent.txHash },
  });
  return { ok: true, payoutId: row.payout_id, amountCents: row.amount_cents, txHash: sent.txHash, status: sent.status };
}

const WEEK_MS = 7 * 86_400_000;

/**
 * The weekly schedule: every active membership with an address and an
 * approved balance at or over the minimum, whose last payout is a week old or
 * older, is paid. Runs from the hourly cron, so "weekly" means at most once
 * in any seven days rather than on a fixed weekday.
 */
export async function runScheduledPayouts(svc: Svc, now = new Date()): Promise<{ paid: number; failed: number; skipped: number }> {
  const { data: sums } = await svc.from("affiliate_conversions").select("membership_id, commission_cents").eq("status", "approved");
  const byMembership = new Map<string, number>();
  for (const r of (sums ?? []) as Array<{ membership_id: string; commission_cents: number }>) {
    byMembership.set(r.membership_id, (byMembership.get(r.membership_id) ?? 0) + r.commission_cents);
  }
  let paid = 0;
  let failed = 0;
  let skipped = 0;
  for (const [membershipId, cents] of byMembership) {
    if (cents < PAYOUT_MIN_CENTS) {
      skipped++;
      continue;
    }
    const membership = await membershipById(membershipId);
    if (!membership || membership.status !== "active" || !membership.payAddress) {
      skipped++;
      continue;
    }
    const { data: last } = await svc
      .from("affiliate_payouts")
      .select("created_at")
      .eq("membership_id", membershipId)
      .in("status", ["sent", "requested"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && now.getTime() - new Date(last.created_at).getTime() < WEEK_MS) {
      skipped++;
      continue;
    }
    const outcome = await requestPayout(membership);
    outcome.ok ? paid++ : failed++;
  }
  return { paid, failed, skipped };
}
