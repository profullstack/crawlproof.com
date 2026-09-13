// Ad budget accounting retains its established 5c redemption denomination.
// This is separate from the purchase price of credits in lib/credits.ts.
// Changing purchase prices must not revalue existing campaign budgets, ledger
// rows, publisher claims or deposit-match promises. Matches the ad SQL RPCs.

// Advertiser budget value per credit; this is not its cash purchase price.
export const CREDIT_CENTS = 5;

// Publisher cash-out value per credit.
//
// Deliberately below even the old cheapest credit pack (2.5c per credit), not
// tied to the current purchase price. Setting it at the floor price left the deepest pack with a 1:1
// spread, and a deposit match on top of that pushed cash in per credit under
// the payout rate — see 20260731120000_ad_solvency.sql. At 2.0c the publisher
// earns 1.4c/credit after the platform rate, which keeps a margin on every
// historical pack with room for the match; repricing new packs does not raise payouts.
export const CREDIT_FLOOR_CENTS = 2.0;

// Minimum real cash that must sit behind every credit granted, in cents. The
// deposit match is capped so a purchase can never dilute below this — a 25%
// margin over the 1.4c publisher payout rate. Mirrors ad_apply_deposit_bonus().
export const MIN_CASH_PER_CREDIT_CENTS = 1.75;

// Default bid / cost-per-click, in credits. 4 credits uses $0.20 of ad budget.
export const CPC_CREDITS = 4;
export const DEFAULT_BID_CREDITS = CPC_CREDITS;
export const CPC_CENTS = CPC_CREDITS * CREDIT_CENTS;

// Trending-topic premium: the rate a trending-targeted click is quoted at,
// in CENTS, and the rate the 90-day promo is free of. Two cents, stated here
// rather than in a marketing page so the dashboard, the CLI and the promo row
// all quote the same number.
//
// It is deliberately expressed in cents and not in credits, because it is
// SMALLER than one credit: a credit is 5c, so $0.02 is 0.4 of one. Nothing
// bills a fraction of a credit today — ad_charge_click moves whole integer
// credits — so a campaign at this rate cannot be metered through the credit
// path once its promo ends. `trendingCpcCredits()` is what that would round
// to; until sub-credit metering exists, a trending campaign after its promo
// bills at the ordinary bid instead, and the gap is a known one rather than a
// silent one.
export const TRENDING_CPC_CENTS = 2;

export function trendingCpcCredits(): number {
  return TRENDING_CPC_CENTS / CREDIT_CENTS;
}

// Platform take rate; the rest accrues to the publisher (at the floor rate).
export const PLATFORM_RATE = 0.3;

// Minimum publisher balance before a withdrawal can be requested, in cents.
export const MIN_PAYOUT_CENTS = 500; // $5.00

// Deposit-match promo: the first deposit is matched 100% of the credits
// BOUGHT (not of the dollar amount at rack — that over-granted on discounted
// packs), capped at $100 of ad budget value and further capped so the deposit never
// dilutes below MIN_CASH_PER_CREDIT_CENTS. ad_apply_deposit_bonus() in
// 20260731120000_ad_solvency.sql is the source of truth.
export const DEPOSIT_MATCH_RATE = 1.0;
export const MAX_DEPOSIT_MATCH_CENTS = 10000; // $100

// Bonus credits a deposit of `amountCents` buying `credits` earns, matching the
// SQL exactly. Exported so the billing UI can quote the promo without guessing.
export function depositBonusCredits(amountCents: number, credits: number): number {
  const solvencyCap = Math.max(
    0,
    Math.floor(amountCents / MIN_CASH_PER_CREDIT_CENTS) - credits,
  );
  return Math.max(
    0,
    Math.min(
      Math.floor(credits * DEPOSIT_MATCH_RATE),
      Math.floor(MAX_DEPOSIT_MATCH_CENTS / CREDIT_CENTS),
      solvencyCap,
    ),
  );
}

// What a publisher actually accrues for a click of N CASH-BACKED credits, in
// whole cents. Clicks funded by promo or bonus credits accrue nothing — there
// is no cash behind them — so callers must pass only the cash-backed slice.
// Mirrors the v_earn expression in ad_charge_click().
export function creditsToPayoutCents(credits: number): number {
  return Math.floor(credits * (1 - PLATFORM_RATE) * CREDIT_FLOOR_CENTS);
}

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
