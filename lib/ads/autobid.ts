// Autobid: the bid a campaign should be making right now, from its budget and
// its delivery. Pure — no clock, no database — so every rule here is testable.
//
// The advertiser sets a daily budget. That is all they set. The bid is what
// this controller says it is, recomputed on the worker's clock (lib/ads/bids.ts
// runs it), and shown to them as a number with a reason beside it.
//
// The controller is a pacing loop, the same shape every ad platform's "maximize
// clicks" strategy takes:
//
//   * A campaign BEHIND its daily pace — it has spent less of its budget than
//     the fraction of the day that has passed — raises its bid, so it wins more
//     of the lottery and catches up.
//   * A campaign AHEAD of pace lowers its bid, so it does not run dry by lunch.
//   * The bid is capped by what the budget could actually cover: a $5/day
//     campaign bidding $2 a click would be finished after two clicks and dark
//     for the rest of the day. The cap buys at least MIN_CLICKS_PER_DAY clicks.
//   * A campaign already bidding well above the market and still behind pace is
//     not losing auctions — there is no inventory for it. Raising further would
//     spend more per click for the same delivery, so it holds.
//
// Money is paper on this network (see the migration that added `autobid`): the
// bid decides delivery share and what a click WOULD have cost, and nothing is
// ever debited. That changes nothing here — the controller does not know or
// care whether the spend it paces is real, which is the point of running it.

import { CREDIT_CENTS, DEFAULT_BID_CREDITS } from "./pricing";

/** The lowest bid autobid ever sets. */
export const AUTOBID_MIN_CREDITS = 1;
/** The highest bid autobid ever sets: 40 credits is $2.00 at rack. */
export const AUTOBID_MAX_CREDITS = 40;
/** The bid cap buys at least this many clicks from a day's budget. */
export const MIN_CLICKS_PER_DAY = 5;
/** Spent less than this fraction of what the day so far should have cost: raise. */
export const BEHIND_PACE_RATIO = 0.7;
/** Spent more than this fraction: lower. */
export const AHEAD_OF_PACE_RATIO = 1.3;
/** Before this much of the UTC day has passed there is too little signal to move. */
export const EARLY_DAY_FRACTION = 0.08;
/** Bidding this many times the market median and still behind pace means inventory, not bids, is the limit. */
export const INVENTORY_LIMITED_MULTIPLE = 2;

export type AutobidReason =
  | "seed"
  | "no_budget"
  | "capped_by_budget"
  | "early_day"
  | "budget_reached"
  | "outbid"
  | "inventory_limited"
  | "behind_pace"
  | "ahead_of_pace"
  | "on_pace";

export const AUTOBID_REASON_LABEL: Record<AutobidReason, string> = {
  seed: "Starting bid",
  no_budget: "No daily budget",
  capped_by_budget: "Capped by daily budget",
  early_day: "Too early in the day to move",
  budget_reached: "Today's budget reached",
  outbid: "Winning nothing at this bid",
  inventory_limited: "Above market, no more inventory to win",
  behind_pace: "Behind pace, raised",
  ahead_of_pace: "Ahead of pace, lowered",
  on_pace: "On pace, held",
};

export type AutobidInput = {
  /** The bid the campaign is making now, in credits. */
  bidCredits: number;
  dailyBudgetCents: number;
  /** Spend that counts against today's budget: real plus paper. */
  spentTodayCents: number;
  /** How much of the UTC day has passed, 0..1. */
  dayFraction: number;
  /** This campaign's fills in the last 24h. */
  impressions24h: number;
  clicks24h: number;
  /** Live campaigns able to fill the same formats, this one included. */
  competitors: number;
  /** Median bid among those competitors, in credits. */
  marketBidCredits: number;
};

export type AutobidSignals = AutobidInput & {
  /** spent / expected-so-far. Above 1 is ahead of pace. */
  paceRatio: number;
  maxBidCredits: number;
};

export type AutobidDecision = {
  bidCredits: number;
  reason: AutobidReason;
  changed: boolean;
  signals: AutobidSignals;
};

/** The most a campaign with this budget should bid: enough for MIN_CLICKS_PER_DAY clicks. */
export function maxAutobidCredits(dailyBudgetCents: number): number {
  const budgetCredits = Math.floor(Math.max(0, dailyBudgetCents) / CREDIT_CENTS);
  const perClick = Math.floor(budgetCredits / MIN_CLICKS_PER_DAY);
  return Math.max(AUTOBID_MIN_CREDITS, Math.min(AUTOBID_MAX_CREDITS, perClick));
}

const clamp = (bid: number, max: number) =>
  Math.max(AUTOBID_MIN_CREDITS, Math.min(max, Math.round(bid)));

/** One step up: a quarter more, and at least one credit. */
export function raiseBid(bid: number, max: number): number {
  return clamp(Math.max(bid + 1, Math.ceil(bid * 1.25)), max);
}

/** One step down: a fifth less, and at least one credit. */
export function lowerBid(bid: number, max: number): number {
  return clamp(Math.min(bid - 1, Math.floor(bid * 0.8)), max);
}

/** The fraction of the UTC day that has passed at `now`. */
export function utcDayFraction(now: Date = new Date()): number {
  const secs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  return secs / 86400;
}

export function decideBid(input: AutobidInput): AutobidDecision {
  const current = Number.isFinite(input.bidCredits) && input.bidCredits > 0
    ? Math.round(input.bidCredits)
    : DEFAULT_BID_CREDITS;
  const max = maxAutobidCredits(input.dailyBudgetCents);
  const expected = input.dailyBudgetCents * Math.max(0, Math.min(1, input.dayFraction));
  const paceRatio = expected > 0 ? input.spentTodayCents / expected : 0;
  const signals: AutobidSignals = { ...input, bidCredits: current, paceRatio, maxBidCredits: max };

  const decide = (bidCredits: number, reason: AutobidReason): AutobidDecision => ({
    bidCredits,
    reason,
    changed: bidCredits !== current,
    signals,
  });

  // Nothing to spend: bid the floor so the campaign still rotates as backfill.
  if (input.dailyBudgetCents <= 0) return decide(AUTOBID_MIN_CREDITS, "no_budget");

  // A budget that was lowered under the bid pulls the bid down with it, at any
  // hour: the cap is a hard rule, not a pacing preference.
  if (current > max) return decide(max, "capped_by_budget");

  // Today's budget is gone: the auction has already demoted this campaign, and
  // the bid it comes back with at 00:00 UTC is the one it had.
  if (input.spentTodayCents + current * CREDIT_CENTS > input.dailyBudgetCents) {
    return decide(current, "budget_reached");
  }

  if (input.dayFraction < EARLY_DAY_FRACTION) return decide(current, "early_day");

  // Winning nothing while others do, and below the market: outbid, not unwanted.
  if (
    input.impressions24h === 0 &&
    input.competitors > 1 &&
    current < input.marketBidCredits
  ) {
    return decide(raiseBid(current, max), "outbid");
  }

  if (paceRatio < BEHIND_PACE_RATIO) {
    // Already paying well over the going rate and still behind: the constraint
    // is inventory. A higher bid buys the same fills at a higher price.
    if (
      input.marketBidCredits > 0 &&
      current >= input.marketBidCredits * INVENTORY_LIMITED_MULTIPLE &&
      input.impressions24h > 0
    ) {
      return decide(current, "inventory_limited");
    }
    return decide(raiseBid(current, max), "behind_pace");
  }

  if (paceRatio > AHEAD_OF_PACE_RATIO) return decide(lowerBid(current, max), "ahead_of_pace");

  return decide(current, "on_pace");
}

/** Median of a list of bids; 0 when empty. */
export function medianBid(bids: number[]): number {
  const sorted = bids.filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------- paper tier

export type PaperBudgetFields = {
  bid_credits?: number | null;
  daily_budget_cents: number;
  paper_spend_today_cents?: number | null;
  paper_spend_date?: string | null;
};

/** Paper spend that counts against today's cap, mirroring spendTodayCents. */
export function paperSpendTodayCents(c: PaperBudgetFields, today: string): number {
  return c.paper_spend_date === today ? (c.paper_spend_today_cents ?? 0) : 0;
}

/** True when one more paper click at this bid would exceed the daily budget. */
export function isPaperBudgetReached(c: PaperBudgetFields, today: string): boolean {
  const bid = c.bid_credits ?? DEFAULT_BID_CREDITS;
  return paperSpendTodayCents(c, today) + bid * CREDIT_CENTS > c.daily_budget_cents;
}

/**
 * Weight a campaign carries in the free-tier lottery.
 *
 * The free tier used to weight everything at 1: nobody was paying, so a bid
 * bought nothing. It is a paper auction now — the same bid-weighted lottery as
 * the paid tier, so bids decide delivery share and the pacing controller has
 * something to pace. A campaign whose paper budget is spent for the day drops
 * to a token weight: it still rotates (every live ad rotates, always), but
 * behind everything that still has budget, exactly as it would on the paid
 * tier. The migration that introduced `autobid` explains the why.
 */
export const PAPER_EXHAUSTED_WEIGHT = 0.5;

export function paperWeight(c: PaperBudgetFields, today: string): number {
  const bid = c.bid_credits ?? DEFAULT_BID_CREDITS;
  if (c.daily_budget_cents <= 0) return PAPER_EXHAUSTED_WEIGHT;
  return isPaperBudgetReached(c, today) ? PAPER_EXHAUSTED_WEIGHT : Math.max(1, bid);
}
