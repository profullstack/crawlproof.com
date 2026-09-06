// What an engagement is worth, what funds it, and the limits on both.
//
// Kept pure and in one file for the same reason lib/ads/pricing.ts is: these
// numbers are the product, they get argued about, and they should be readable
// without a database.
//
// The unit is MICROS — millionths of a dollar. One ad read is worth a small
// fraction of a cent and cents round every one of them to zero.

export const MICROS_PER_CENT = 10_000;
export const MICROS_PER_DOLLAR = 1_000_000;

/**
 * The share of crawler pass revenue that becomes reader rewards.
 *
 * This is the "20% cut" the programme promises, and it is applied to the money
 * the CRAWLERS pay, not to the advertiser's click. The click cannot carry it:
 * after the publisher's share there are about 0.35c left per credit, and paying
 * a reader out of that would put the network underwater on discounted credit
 * packs — the insolvency 20260731120000_ad_solvency.sql exists to prevent.
 * Pass revenue has no publisher split, so this share is real margin being
 * shared rather than a promise written against someone else's money.
 */
export const POOL_SHARE = 0.2;

/** What each action pays, in micros. */
export const REWARD_MICROS = {
  // Read: the unit was open and in front of somebody for MIN_READ_DWELL_MS.
  read: 500, // $0.0005
  // Respond: a reaction or a short answer to the advertiser's question.
  respond: 5_000, // $0.005
  // Follow: the reader opted in to hear from this advertiser again. Worth the
  // most because it is the only one an advertiser can act on later.
  follow: 25_000, // $0.025
} as const;

export type EarnAction = keyof typeof REWARD_MICROS;
export const EARN_ACTIONS = Object.keys(REWARD_MICROS) as EarnAction[];
export const isEarnAction = (v: unknown): v is EarnAction =>
  typeof v === "string" && (EARN_ACTIONS as string[]).includes(v);

/**
 * How long the unit must have been in view before a read counts.
 *
 * A view alone pays nothing. Paying per impression is what makes a farm worth
 * building, and ten seconds of a real viewport is expensive to fake at scale
 * and cheap for a person who was reading anyway.
 */
export const MIN_READ_DWELL_MS = 10_000;

/** Beyond this, the browser is lying or the tab was left open. Clamped, not refused. */
export const MAX_DWELL_MS = 10 * 60 * 1000;

/**
 * Per-account daily ceilings. The micros cap is the one that matters; the event
 * cap stops a script burning through the pool a fraction of a cent at a time
 * and filling the events table doing it.
 *
 * The same micros cap is applied per IP hash, shared across every account behind
 * it, so twenty sock puppets on one machine earn what one account would.
 */
export const DAILY_EVENT_CAP = 200;
export const DAILY_MICROS_CAP = 100_000; // $0.10

/** No withdrawal below this. Under it the payout fee eats the payout. */
export const MIN_PAYOUT_CENTS = 500; // $5.00

/** How long a new account accrues before it may withdraw. */
export const PROBATION_DAYS = 7;

/** Default payout coin. A dollar coin with cent-level fees. */
export const PAYOUT_CURRENCY = "USDC_POL";

/** What a pass payment of `amountCents` contributes to the reward pool. */
export function poolShareMicros(amountCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  return Math.floor(amountCents * MICROS_PER_CENT * POOL_SHARE);
}

/** What one action is worth, or 0 for anything not on the list. */
export function rewardFor(action: string): number {
  return isEarnAction(action) ? REWARD_MICROS[action] : 0;
}

/**
 * Whole cents withdrawable from a micros balance. Floors: the remainder stays
 * on the balance rather than being invented or lost.
 */
export function withdrawableCents(balanceMicros: number): number {
  if (!Number.isFinite(balanceMicros) || balanceMicros <= 0) return 0;
  return Math.floor(balanceMicros / MICROS_PER_CENT);
}

/** Whether a balance can be withdrawn at all yet. */
export function canWithdraw(balanceMicros: number): boolean {
  return withdrawableCents(balanceMicros) >= MIN_PAYOUT_CENTS;
}

/** "$0.0005" / "$1.25" — small amounts keep their digits, big ones do not. */
export function formatMicros(micros: number): string {
  const dollars = (Number(micros) || 0) / MICROS_PER_DOLLAR;
  if (dollars !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Clamp a claimed dwell to something a browser could honestly report. */
export function cleanDwell(value: unknown): number {
  const ms = Math.floor(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_DWELL_MS);
}

/** Whether probation is over for an account created at `createdAt`. */
export function probationCleared(createdAt: string | Date, now: Date = new Date()): boolean {
  const started = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(started.getTime())) return false;
  return now.getTime() - started.getTime() >= PROBATION_DAYS * 24 * 60 * 60 * 1000;
}
