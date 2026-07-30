// Advertiser-facing campaign status. The stored `ad_campaigns.status` doesn't
// tell the whole story, because two very different things stop a campaign from
// serving and only one of them writes to that column:
//
//   * Daily budget reached — status stays 'active'. ad_charge_click leaves the
//     column alone and only records an unbilled click; serveAd() filters the
//     campaign out of the auction. The counter resets on the next UTC day, so
//     the campaign resumes on its own with no advertiser action.
//   * Out of ad credits — ad_charge_click flips status to 'exhausted'. Nothing
//     ever flips it back (a deposit grants credits but doesn't touch campaign
//     status), so this one needs a manual Activate.
//
// Rendering the raw column made those two look identical — a stalled campaign
// with no explanation. campaignDisplayStatus() derives the distinction so the
// dashboard can say which one happened and whether it self-heals.

import { CREDIT_CENTS, DEFAULT_BID_CREDITS } from "./pricing";

export type CampaignBudgetFields = {
  status: string;
  daily_budget_cents: number;
  spend_today_cents?: number | null;
  spend_date?: string | null;
  bid_credits?: number | null;
};

export type CampaignDisplayStatus = {
  /** Badge text. */
  label: string;
  /** One-line explanation of why it's in this state. */
  hint: string;
  /** Eligible to fill a slot right now. */
  serving: boolean;
  /** Comes back without the advertiser doing anything. */
  resumesAutomatically: boolean;
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
  // Mirrors the eligibility filter in serveAd() — keep the two in step.
  return spendTodayCents(c, today) + bid * CREDIT_CENTS > c.daily_budget_cents;
}

export function campaignDisplayStatus(
  c: CampaignBudgetFields,
  today: string = utcToday(),
): CampaignDisplayStatus {
  if (c.status === "exhausted") {
    return {
      label: "out of credits",
      hint: "Ran out of ad credits, so the campaign stopped. Top up your credits, then press Activate — it won't restart on its own.",
      serving: false,
      resumesAutomatically: false,
    };
  }

  if (c.status !== "active") {
    return {
      label: c.status,
      hint:
        c.status === "paused"
          ? "Paused by you. Press Activate to resume."
          : "Not live yet. Press Activate to start serving.",
      serving: false,
      resumesAutomatically: false,
    };
  }

  if (isDailyBudgetReached(c, today)) {
    return {
      label: "daily budget reached",
      hint: "Today's budget is spent. Serving resumes automatically at 00:00 UTC — raise the daily budget to keep going sooner.",
      serving: false,
      resumesAutomatically: true,
    };
  }

  return {
    label: "active",
    hint: "Live and eligible to serve.",
    serving: true,
    resumesAutomatically: true,
  };
}
