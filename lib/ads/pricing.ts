// Ad network pricing. Advertiser spend is denominated in the existing credit
// unit (1 credit = 5¢, see lib/credits.ts CREDIT_RACK_CENTS) so one currency
// governs the app. v1 is a flat CPC; auction pricing is a later phase.

// Advertiser spend value per credit (rack). Matches CREDIT_RACK_CENTS.
export const CREDIT_CENTS = 5;

// Publisher cash-out value per credit — the FLOOR price (cheapest credit pack).
// The rack↔floor spread is what keeps payouts solvent under a deposit match.
export const CREDIT_FLOOR_CENTS = 2.5;

// Default bid / cost-per-click, in credits. 4 credits = $0.20 at rack.
export const CPC_CREDITS = 4;
export const DEFAULT_BID_CREDITS = CPC_CREDITS;
export const CPC_CENTS = CPC_CREDITS * CREDIT_CENTS;

// Platform take rate; the rest accrues to the publisher (at the floor rate).
export const PLATFORM_RATE = 0.3;

// Minimum publisher balance before a withdrawal can be requested, in cents.
export const MIN_PAYOUT_CENTS = 500; // $5.00

// Deposit-match promo: first deposit is matched 100% in bonus ad credits,
// capped. Mirrors ad_apply_deposit_bonus() in the migration (source of truth).
export const DEPOSIT_MATCH_RATE = 1.0;
export const MAX_DEPOSIT_MATCH_CENTS = 10000; // $100

// Publisher cash value of N credits at the floor rate, in whole cents.
export function creditsToPayoutCents(credits: number): number {
  return Math.floor(credits * CREDIT_FLOOR_CENTS);
}

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
