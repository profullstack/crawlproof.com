// Advertiser-facing campaign status.
//
// A campaign never stops serving because it ran out of money. Running dry drops
// it to the FREE TIER instead: it keeps rendering, but only as backfill on
// inventory no paying campaign wanted, and those impressions/clicks bill nobody
// and earn the publisher nothing. Two things drop a campaign to free tier, and
// both self-heal without the advertiser touching anything:
//
//   * Daily budget reached — the counter resets at 00:00 UTC.
//   * Out of ad credits — a top-up restores paid delivery immediately.
//
// Before this, out-of-credits flipped ad_campaigns.status to 'exhausted' and
// nothing ever flipped it back, so a campaign died silently and needed a manual
// Activate. That status is no longer written; any row still carrying it is
// treated as an ordinary active campaign on the free tier.

import { CREDIT_CENTS, DEFAULT_BID_CREDITS } from "./pricing";

export type CampaignBudgetFields = {
  status: string;
  daily_budget_cents: number;
  spend_today_cents?: number | null;
  spend_date?: string | null;
  bid_credits?: number | null;
};

/** Which inventory a campaign can win right now. */
export type CampaignTier = "paid" | "free" | "none";

export type CampaignDisplayStatus = {
  /** Badge text. */
  label: string;
  /** One-line explanation of why it's in this state. */
  hint: string;
  /** Rendering somewhere right now — on either tier. */
  serving: boolean;
  /** Returns to paid delivery without the advertiser doing anything. */
  resumesAutomatically: boolean;
  /** Paid auction, free backfill only, or not serving at all. */
  tier: CampaignTier;
};

/** The day boundary the budget counter resets on — UTC, matching SQL current_date. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// Spend that counts against today's cap. The stored counter is only meaningful
// when spend_date is today; on a new UTC day it's last-active-day's total that
// nothing has zeroed yet (both serveAd and ad_charge_click reset it lazily).
export function spendTodayCents(c: CampaignBudgetFields, today: string = utcToday()): number {
  return c.spend_date === today ? (c.spend_today_cents ?? 0) : 0;
}

/** True when one more click at this campaign's bid would exceed the daily cap. */
export function isDailyBudgetReached(
  c: CampaignBudgetFields,
  today: string = utcToday(),
): boolean {
  const bid = c.bid_credits ?? DEFAULT_BID_CREDITS;
  // Mirrors the paid-eligibility filter in serveAd() — keep the two in step.
  return spendTodayCents(c, today) + bid * CREDIT_CENTS > c.daily_budget_cents;
}

/**
 * True when the advertiser can't cover one more click at this bid.
 *
 * `creditsAvailable` is the owner's spendable total (paid + promo + bonus).
 * Undefined means "not looked up" — callers without the balance to hand get
 * paid-tier optimism rather than a wrong "out of credits" badge, and
 * ad_charge_click still refuses to bill what isn't there.
 */
export function isOutOfCredits(
  c: CampaignBudgetFields,
  creditsAvailable?: number | null,
): boolean {
  if (creditsAvailable == null) return false;
  return creditsAvailable < (c.bid_credits ?? DEFAULT_BID_CREDITS);
}

/** Which tier a campaign is eligible for right now. */
export function campaignTier(
  c: CampaignBudgetFields,
  today: string = utcToday(),
  creditsAvailable?: number | null,
): CampaignTier {
  // 'exhausted' is legacy — treat it as active, on the free tier.
  if (c.status !== "active" && c.status !== "exhausted") return "none";
  if (c.status === "exhausted") return "free";
  if (isOutOfCredits(c, creditsAvailable)) return "free";
  if (isDailyBudgetReached(c, today)) return "free";
  return "paid";
}

export function campaignDisplayStatus(
  c: CampaignBudgetFields,
  today: string = utcToday(),
  creditsAvailable?: number | null,
): CampaignDisplayStatus {
  const tier = campaignTier(c, today, creditsAvailable);

  if (tier === "none") {
    return {
      label: c.status,
      hint:
        c.status === "paused"
          ? "Paused by you. Press Activate to resume."
          : "Not live yet. Press Activate to start serving.",
      serving: false,
      resumesAutomatically: false,
      tier,
    };
  }

  if (tier === "free") {
    // Out of credits takes precedence in the copy: it's the one the advertiser
    // has to act on to get back to paid delivery.
    const broke = c.status === "exhausted" || isOutOfCredits(c, creditsAvailable);
    return {
      label: "free tier",
      hint: broke
        ? "Out of ad credits, so it's running as free backfill — still shown on unsold inventory, but it can't win paid placements and you're not charged. Top up to restore priority delivery."
        : "Today's budget is spent, so it's running as free backfill — still shown on unsold inventory at no cost. Priority delivery resumes at 00:00 UTC, or raise the daily budget to get it back sooner.",
      serving: true,
      resumesAutomatically: true,
      tier,
    };
  }

  return {
    label: "active",
    hint: "Live and competing for paid placements.",
    serving: true,
    resumesAutomatically: true,
    tier,
  };
}
