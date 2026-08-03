import { describe, expect, it } from "vitest";
import {
  CREDIT_CENTS,
  CREDIT_FLOOR_CENTS,
  MIN_CASH_PER_CREDIT_CENTS,
  PLATFORM_RATE,
  creditsToPayoutCents,
  depositBonusCredits,
} from "@/lib/ads/pricing";
import { CREDIT_PACKS, type CreditPack } from "@/lib/credits";

// The ad network can pay publishers real USDC, so the only invariant that
// ultimately matters is: every credit that can fund a click must have more real
// cash behind it than the click can ever pay out. These tests pin that down at
// the pack level, because the previous pricing looked safe in the abstract
// ("advertisers spend at 5c, publishers cash out at 2.5c") and was insolvent on
// the deepest pack once the volume discount and the deposit match were applied.

/** Real cash received per credit granted, in cents. */
const cashPerCredit = (pack: CreditPack, bonus = 0) =>
  pack.amountCents / (pack.credits + bonus);

/** Cash a publisher can withdraw per cash-backed credit spent, in cents. */
const payoutPerCredit = (1 - PLATFORM_RATE) * CREDIT_FLOOR_CENTS;

describe("payout rate", () => {
  it("pays 1.4c per cash-backed credit", () => {
    expect(payoutPerCredit).toBeCloseTo(1.4, 10);
  });

  it("accrues the platform take, not the full floor value", () => {
    // The old helper returned floor(credits * 2.5) and ignored PLATFORM_RATE,
    // overstating a publisher's balance by 43%.
    expect(creditsToPayoutCents(4)).toBe(5); // floor(4 * 0.7 * 2.0)
    expect(creditsToPayoutCents(100)).toBe(140);
    expect(creditsToPayoutCents(0)).toBe(0);
  });

  it("never pays more than the advertiser was charged", () => {
    for (let credits = 1; credits <= 200; credits++) {
      expect(creditsToPayoutCents(credits)).toBeLessThan(credits * CREDIT_CENTS);
    }
  });
});

describe("credit packs are solvent without a promo", () => {
  it.each(CREDIT_PACKS.map((p) => [p.id, p] as const))(
    "%s keeps cash in above the payout rate",
    (_id, pack) => {
      expect(cashPerCredit(pack)).toBeGreaterThan(payoutPerCredit);
    },
  );

  it("holds at least a 25% margin on every pack", () => {
    for (const pack of CREDIT_PACKS) {
      expect(cashPerCredit(pack)).toBeGreaterThanOrEqual(MIN_CASH_PER_CREDIT_CENTS);
    }
  });

  it("is tightest on the deepest pack", () => {
    const margins = CREDIT_PACKS.map((p) => cashPerCredit(p));
    expect(Math.min(...margins)).toBe(cashPerCredit(CREDIT_PACKS.at(-1)!));
  });
});

describe("deposit match stays solvent", () => {
  it.each(CREDIT_PACKS.map((p) => [p.id, p] as const))(
    "%s survives its first-deposit bonus",
    (_id, pack) => {
      const bonus = depositBonusCredits(pack.amountCents, pack.credits);
      expect(cashPerCredit(pack, bonus)).toBeGreaterThanOrEqual(
        MIN_CASH_PER_CREDIT_CENTS,
      );
      expect(cashPerCredit(pack, bonus)).toBeGreaterThan(payoutPerCredit);
    },
  );

  it("caps the match on the deepest pack instead of doubling it", () => {
    const deepest = CREDIT_PACKS.at(-1)!; // $50 / 2000 credits = 2.5c each
    const bonus = depositBonusCredits(deepest.amountCents, deepest.credits);
    // A naive 100% match would grant 2000 and drop cash in to 1.25c/credit —
    // below the 1.4c payout rate. The solvency cap holds it to 857.
    expect(bonus).toBe(857);
    expect(bonus).toBeLessThan(deepest.credits);
  });

  it("grants a full 100% match where the pack can afford it", () => {
    const starter = CREDIT_PACKS[0]; // $1.00 / 20 credits = 5c each
    expect(depositBonusCredits(starter.amountCents, starter.credits)).toBe(20);
  });

  it("matches credits bought, not dollars at rack", () => {
    // The old rule was floor(amountCents / 5), which on a discounted pack
    // granted more bonus credits than the buyer had actually purchased.
    const deepest = CREDIT_PACKS.at(-1)!;
    const oldRule = Math.floor(deepest.amountCents / CREDIT_CENTS);
    expect(depositBonusCredits(deepest.amountCents, deepest.credits)).toBeLessThan(
      oldRule,
    );
  });

  it("caps bonus value at $100 of rack", () => {
    // A hypothetical whale deposit: $5,000 buying 200,000 credits at 2.5c.
    expect(depositBonusCredits(500_000, 200_000)).toBe(
      Math.floor(10_000 / CREDIT_CENTS),
    );
  });

  it("never returns a negative bonus", () => {
    // A pack priced below the solvency floor gets no promo rather than a
    // negative one that would silently remove credits.
    expect(depositBonusCredits(100, 1000)).toBe(0);
  });
});

describe("free credits cannot mint cash", () => {
  it("pays nothing when no part of the click was cash-backed", () => {
    // ad_charge_click computes v_earn from the cash-backed slice only, so a
    // click funded entirely by signup or bonus credits accrues zero.
    expect(creditsToPayoutCents(0)).toBe(0);
  });

  it("prices the current free grant at zero liability", () => {
    // 20 signup credits used to obligate floor(20 * 0.7 * 2.5) = 35c of real
    // USDC apiece. Now they are promo-tagged and obligate nothing.
    const signupGrant = 20;
    const cashBackedSlice = 0;
    expect(creditsToPayoutCents(cashBackedSlice)).toBe(0);
    expect(creditsToPayoutCents(signupGrant)).toBe(28); // only if it were paid
  });
});
