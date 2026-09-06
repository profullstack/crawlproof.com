// The rail itself: money in from crawlers, rewards out to readers, transfers
// between any two parties, and withdrawals off the network.
//
// Every one of these is a thin wrapper over a plpgsql function. That is on
// purpose. The caps, the pool solvency check and the balance arithmetic all
// have to hold under concurrent requests, and the only place they can is
// inside one statement in the database. Doing it here would be a read, a
// decision, and a write with a race in the middle of it.

import { serviceClient } from "@/lib/supabase/service";
import { createCryptoPayout } from "@/lib/coinpay";
import {
  DAILY_EVENT_CAP,
  DAILY_MICROS_CAP,
  MIN_PAYOUT_CENTS,
  MIN_READ_DWELL_MS,
  PAYOUT_CURRENCY,
  poolShareMicros,
  rewardFor,
  withdrawableCents,
  type EarnAction,
} from "./rates";
import { accountById, type EarnAccount } from "./accounts";

const big = (v: unknown): number => Number(v ?? 0) || 0;

/* ────────────────────────────────────────────────────────────────────────────
   Money in
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A crawler paid for a day pass; a share of it becomes reader rewards.
 *
 * `ref` is the pass payment's own id and the call is idempotent on it, because
 * a settlement notice is a reason to record money rather than proof it has not
 * already been recorded.
 */
export async function fundPoolFromPass(input: {
  amountCents: number;
  ref: string;
  reason?: string;
}): Promise<{ ok: true; availableMicros: number } | { ok: false; error: string }> {
  const micros = poolShareMicros(input.amountCents);
  if (micros <= 0) return { ok: false, error: "Nothing to fund." };
  const { data, error } = await serviceClient().rpc("earn_fund_pool", {
    p_amount_micros: micros,
    p_ref: input.ref,
    p_reason: input.reason ?? "crawler day pass",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, availableMicros: big(data) };
}

/** What is left to reward, right now. Also the network-wide spend ceiling. */
export async function poolAvailableMicros(): Promise<number> {
  const { data } = await serviceClient()
    .from("earn_pool")
    .select("funded_micros, rewarded_micros")
    .maybeSingle();
  if (!data) return 0;
  const row = data as { funded_micros: number | string; rewarded_micros: number | string };
  return Math.max(0, big(row.funded_micros) - big(row.rewarded_micros));
}

/* ────────────────────────────────────────────────────────────────────────────
   Rewards
   ──────────────────────────────────────────────────────────────────────── */

export type AwardResult = {
  accepted: boolean;
  rewardMicros: number;
  reason: string | null;
  eventId: string | null;
};

/**
 * One engagement. The database decides whether it pays and how much; this
 * only supplies the rate and the limits, which live in rates.ts so they can be
 * read and argued about without a query.
 */
export async function award(input: {
  accountId: string;
  action: EarnAction;
  campaignId?: string | null;
  slotId?: string | null;
  ipHash?: string | null;
  dwellMs?: number | null;
}): Promise<AwardResult> {
  const { data, error } = await serviceClient().rpc("earn_award", {
    p_account: input.accountId,
    p_action: input.action,
    p_reward_micros: rewardFor(input.action),
    p_campaign: input.campaignId ?? null,
    p_slot: input.slotId ?? null,
    p_ip_hash: input.ipHash ?? null,
    p_dwell_ms: input.dwellMs ?? null,
    p_min_dwell_ms: MIN_READ_DWELL_MS,
    p_daily_event_cap: DAILY_EVENT_CAP,
    p_daily_micros_cap: DAILY_MICROS_CAP,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { event_id: string | null; reward_micros: number | string; accepted: boolean; reason: string | null }
    | undefined;
  return {
    accepted: Boolean(row?.accepted),
    rewardMicros: big(row?.reward_micros),
    reason: row?.reason ?? null,
    eventId: row?.event_id ?? null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Transfers — any party pays any party
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Human to agent, agent to agent, agent to human. The rail does not care which
 * and deliberately so: an agent paying another agent for a summary is the same
 * movement as a reader tipping a bot that wrote something useful.
 *
 * Moves only value already funded, so it cannot affect solvency.
 */
export async function transfer(input: {
  fromAccountId: string;
  toAccountId: string;
  amountMicros: number;
  reason?: string | null;
  ref?: string | null;
}): Promise<
  | { ok: true; ledgerId: string; fromBalanceMicros: number; toBalanceMicros: number }
  | { ok: false; error: string }
> {
  const amount = Math.floor(Number(input.amountMicros));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "The amount has to be more than nothing." };
  }
  if (input.fromAccountId === input.toAccountId) {
    return { ok: false, error: "An account cannot pay itself." };
  }
  const { data, error } = await serviceClient().rpc("earn_transfer", {
    p_from: input.fromAccountId,
    p_to: input.toAccountId,
    p_amount_micros: amount,
    p_reason: input.reason ?? null,
    p_ref: input.ref ?? null,
  });
  if (error) {
    // The function raises for every refusal, and its messages are already
    // written to be read by a person.
    return { ok: false, error: error.message.replace(/^.*earn_transfer:\s*/, "") };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { ledger_id: string; from_balance: number | string; to_balance: number | string }
    | undefined;
  if (!row) return { ok: false, error: "The transfer did not go through." };
  return {
    ok: true,
    ledgerId: row.ledger_id,
    fromBalanceMicros: big(row.from_balance),
    toBalanceMicros: big(row.to_balance),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   Withdrawals
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Value leaves the rail, in USDC, through the same CoinPay payout endpoint the
 * publisher withdrawals use.
 *
 * The balance is debited as the row is written, before CoinPay is called, so
 * two requests in flight cannot both be funded. A send that fails puts it back.
 */
export async function requestPayout(input: {
  account: EarnAccount;
  amountCents?: number;
}): Promise<
  | { ok: true; payoutId: string; amountCents: number; txHash: string | null }
  | { ok: false; error: string }
> {
  const account = input.account;
  const available = withdrawableCents(account.balanceMicros);
  const amount = Math.floor(input.amountCents ?? available);

  if (account.status === "suspended") return { ok: false, error: "This account cannot withdraw." };
  if (account.status === "probation") {
    return { ok: false, error: "New accounts can earn straight away but withdraw after a week." };
  }
  if (!account.payoutAddress) return { ok: false, error: "Add a wallet address first." };
  if (amount < MIN_PAYOUT_CENTS) {
    return {
      ok: false,
      error: `The smallest withdrawal is $${(MIN_PAYOUT_CENTS / 100).toFixed(2)}. You have $${(available / 100).toFixed(2)}.`,
    };
  }
  if (amount > available) return { ok: false, error: "That is more than the balance." };

  const sb = serviceClient();
  const { data: payoutId, error } = await sb.rpc("earn_request_payout", {
    p_account: account.id,
    p_amount_cents: amount,
    p_currency: PAYOUT_CURRENCY,
  });
  if (error) {
    return { ok: false, error: error.message.replace(/^.*earn_request_payout:\s*/, "") };
  }
  const id = String(payoutId);

  const sent = await createCryptoPayout({
    recipientEmail: account.payoutEmail ?? "",
    recipientWallet: account.payoutAddress,
    amountUsd: amount / 100,
    currency: PAYOUT_CURRENCY,
  });
  if (!sent.ok) {
    // Puts the money back on the balance and marks the row failed.
    await sb.rpc("earn_fail_payout", { p_payout: id, p_error: sent.error });
    return { ok: false, error: sent.error };
  }

  await sb
    .from("earn_payouts")
    .update({
      status: "sent",
      coinpay_payout_id: sent.payoutId ?? null,
      tx_hash: sent.txHash ?? null,
      settled_at: new Date().toISOString(),
    })
    .eq("id", id);

  return { ok: true, payoutId: id, amountCents: amount, txHash: sent.txHash ?? null };
}

/* ────────────────────────────────────────────────────────────────────────────
   Reading it back
   ──────────────────────────────────────────────────────────────────────── */

export type RailSummary = {
  account: EarnAccount;
  withdrawableCents: number;
  poolAvailableMicros: number;
  recent: Array<{
    id: string;
    kind: string;
    amountMicros: number;
    reason: string | null;
    direction: "in" | "out";
    createdAt: string;
  }>;
};

export async function summaryFor(accountId: string): Promise<RailSummary | null> {
  const account = await accountById(accountId);
  if (!account) return null;
  const { data } = await serviceClient()
    .from("earn_ledger")
    .select("id, kind, amount_micros, reason, from_account, to_account, created_at")
    .or(`to_account.eq.${accountId},from_account.eq.${accountId}`)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<{
    id: string;
    kind: string;
    amount_micros: number | string;
    reason: string | null;
    from_account: string | null;
    to_account: string | null;
    created_at: string;
  }>;
  return {
    account,
    withdrawableCents: withdrawableCents(account.balanceMicros),
    poolAvailableMicros: await poolAvailableMicros(),
    recent: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amountMicros: big(row.amount_micros),
      reason: row.reason,
      direction: row.to_account === accountId ? "in" : "out",
      createdAt: row.created_at,
    })),
  };
}
