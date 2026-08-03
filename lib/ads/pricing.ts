// Ad network pricing. Advertiser spend is denominated in the existing credit
// unit (1 credit = 5¢, see lib/credits.ts CREDIT_RACK_CENTS) so one currency
// governs the app. v1 is a flat CPC; auction pricing is a later phase.

// Advertiser spend value per credit (rack). Matches CREDIT_RACK_CENTS.
export const CREDIT_CENTS = 5;

// Publisher cash-out value per credit.
//
// Deliberately BELOW the cheapest credit pack (2.5c on the 100-scan tier), not
// equal to it. Setting it at the floor price left the deepest pack with a 1:1
// spread, and a deposit match on top of that pushed cash in per credit under
// the payout rate — see 20260731120000_ad_solvency.sql. At 2.0c the publisher
// earns 1.4c/credit after the platform rate, which keeps a margin on every
// pack (72% at rack, 44% on the deepest) with room for the match.
export const CREDIT_FLOOR_CENTS = 2.0;

// Minimum real cash that must sit behind every credit granted, in cents. The
// deposit match is capped so a purchase can never dilute below this — a 25%
// margin over the 1.4c publisher payout rate. Mirrors ad_apply_deposit_bonus().
export const MIN_CASH_PER_CREDIT_CENTS = 1.75;

// Default bid / cost-per-click, in credits. 4 credits = $0.20 at rack.
export const CPC_CREDITS = 4;
export const DEFAULT_BID_CREDITS = CPC_CREDITS;
export const CPC_CENTS = CPC_CREDITS * CREDIT_CENTS;

// Platform take rate; the rest accrues to the publisher (at the floor rate).
export const PLATFORM_RATE = 0.3;

// Minimum publisher balance before a withdrawal can be requested, in cents.
export const MIN_PAYOUT_CENTS = 500; // $5.00

// Deposit-match promo: the first deposit is matched 100% of the credits
// BOUGHT (not of the dollar amount at rack — that over-granted on discounted
// packs), capped at $100 of rack value and further capped so the deposit never
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
