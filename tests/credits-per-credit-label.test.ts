// The pricing page was overstating its own prices.
//
// Every bundle's true per-credit price lands on a half-cent, and
// `Math.round` on integer cents took all three of them UP: $0.045 shown as
// $0.05, $0.035 as $0.04, $0.025 as $0.03. Reported by a visitor who did the
// division, which is the worst way to find out.

import { describe, expect, it } from "vitest";
import {
  CREDIT_PACKS,
  SIGNUP_CREDITS,
  SCAN_CREDITS,
  findPack,
  perCreditLabel,
} from "@/lib/credits";

describe("perCreditLabel", () => {
  it.each([
    ["pack-1", "$0.05"], // $1.00 / 20 — genuinely round
    ["pack-10", "$0.045"], // $9 / 200, was shown as $0.05
    ["pack-50", "$0.035"], // $35 / 1000, was shown as $0.04
    ["pack-100", "$0.025"], // $50 / 2000, was shown as $0.03
  ])("prices %s at %s", (id, expected) => {
    const pack = findPack(id);
    expect(pack).toBeDefined();
    expect(perCreditLabel(pack!)).toBe(expected);
  });

  it("never overstates the price", () => {
    // The property that actually matters: what we print must be <= what we
    // charge, for every pack, including any added later.
    for (const pack of CREDIT_PACKS) {
      const printed = Number(perCreditLabel(pack).slice(1));
      const actual = pack.amountCents / pack.credits / 100;
      expect(printed).toBeLessThanOrEqual(actual + 1e-9);
    }
  });

  it("keeps at least two decimals, so a price never reads as a typo", () => {
    for (const pack of CREDIT_PACKS) {
      const decimals = perCreditLabel(pack).split(".")[1] ?? "";
      expect(decimals.length).toBeGreaterThanOrEqual(2);
      expect(decimals.length).toBeLessThanOrEqual(3);
    }
  });

  it("is exact to three decimals for every pack", () => {
    for (const pack of CREDIT_PACKS) {
      const printed = Number(perCreditLabel(pack).slice(1));
      const actual = pack.amountCents / pack.credits / 100;
      expect(printed).toBeCloseTo(actual, 3);
    }
  });
});

describe("signup credits", () => {
  it("is one AI-model scan, which is what the copy claims", () => {
    // Several pages say "N free credits (1 AI-model scan)". If these ever
    // diverge, that sentence becomes false everywhere at once.
    expect(SIGNUP_CREDITS).toBe(SCAN_CREDITS);
    expect(SIGNUP_CREDITS / SCAN_CREDITS).toBe(1);
  });

  it("matches the profiles.credits_balance column default of 20", () => {
    // The database default is what actually grants the credits; this constant
    // only describes it. Pinned so a change here without a migration is loud.
    expect(SIGNUP_CREDITS).toBe(20);
  });
});
