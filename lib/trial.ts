// The 30-day free trial of paid features. No card, nothing renews.
//
// Mirrors supabase/migrations/20261122120000_free_trial_and_buyer_intent.sql:
// every account gets trial_ends_at = signup + TRIAL_DAYS and a TRIAL_CREDITS
// pool that consume_credit spends before the paid balance while the trial is
// live. Change both together.

export const TRIAL_DAYS = 30;
export const TRIAL_CREDITS = 300;

/** Columns to select from profiles to compute spendable credits. */
export const CREDIT_COLUMNS = "credits_balance, trial_credits, trial_ends_at";

export type TrialProfile = {
  credits_balance?: number | null;
  trial_credits?: number | null;
  trial_ends_at?: string | null;
};

export type TrialStatus = {
  active: boolean;
  endsAt: string | null;
  daysLeft: number;
  creditsLeft: number;
};

const DAY = 86_400_000;

export function trialStatus(p: TrialProfile | null | undefined, now = new Date()): TrialStatus {
  const endsAt = p?.trial_ends_at ?? null;
  const endMs = endsAt ? Date.parse(endsAt) : NaN;
  const active = Number.isFinite(endMs) && endMs > now.getTime();
  return {
    active,
    endsAt,
    daysLeft: active ? Math.ceil((endMs - now.getTime()) / DAY) : 0,
    creditsLeft: active ? Math.max(0, p?.trial_credits ?? 0) : 0,
  };
}

/** What consume_credit would let this account spend right now. */
export function spendableCredits(p: TrialProfile | null | undefined, now = new Date()): number {
  return Math.max(0, p?.credits_balance ?? 0) + trialStatus(p, now).creditsLeft;
}
