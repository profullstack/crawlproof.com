// Ad network pricing. Advertiser spend is denominated in the existing credit
// unit (1 credit = 5¢, see lib/credits.ts CREDIT_RACK_CENTS) so one currency
// governs the app. v1 is a flat CPC; auction pricing is a later phase.

export const CREDIT_CENTS = 5;

// Cost per click, in credits. 4 credits = $0.20/click.
export const CPC_CREDITS = 4;
export const CPC_CENTS = CPC_CREDITS * CREDIT_CENTS;

// Platform take rate; the rest accrues to the publisher.
export const PLATFORM_RATE = 0.3;

// Minimum publisher balance before a withdrawal can be requested, in cents.
export const MIN_PAYOUT_CENTS = 500; // $5.00

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
