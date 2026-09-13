/** Markup on estimated service costs, before affiliate and payment fees. */
export const TARGET_MARKUP_PERCENT = 400;
export const MAX_VOLUME_DISCOUNT_PERCENT = 50;

/** Existing service-cost estimates, in cents per action. */
export const SERVICE_COST_CENTS = {
  scan: 26,
  leadRun: 4.9,
  outreach: 3,
} as const;

/** A 400% markup charges five times cost. Round up to a whole cent. */
export function quoteServiceCostMarkup(serviceCents: number): number {
  if (!Number.isFinite(serviceCents) || serviceCents < 0) {
    throw new RangeError("Service cost must be finite and non-negative.");
  }
  return Math.ceil(serviceCents * (1 + TARGET_MARKUP_PERCENT / 100));
}
