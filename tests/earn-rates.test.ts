import { describe, expect, it } from "vitest";
import {
  DAILY_MICROS_CAP,
  MICROS_PER_CENT,
  MIN_PAYOUT_CENTS,
  MIN_READ_DWELL_MS,
  MAX_DWELL_MS,
  POOL_SHARE,
  REWARD_MICROS,
  canWithdraw,
  cleanDwell,
  formatMicros,
  isEarnAction,
  poolShareMicros,
  probationCleared,
  rewardFor,
  withdrawableCents,
} from "@/lib/earn/rates";

// The earn rail pays readers out of what crawlers pay for day passes, never
// out of the advertiser's click. These are the numbers that makes that work,
// and the properties that keep it solvent.

describe("the pool is funded from crawler passes", () => {
  it("takes the advertised share and never more", () => {
    // A $1.00 day pass at a 20% share is 20 cents, which is 200,000 micros.
    expect(poolShareMicros(100)).toBe(200_000);
    expect(POOL_SHARE).toBe(0.2);
    // The share is a floor, so rounding can never invent value that was not
    // paid in — the whole solvency argument rests on that direction.
    expect(poolShareMicros(1)).toBeLessThanOrEqual(1 * MICROS_PER_CENT * POOL_SHARE);
    expect(poolShareMicros(33)).toBe(Math.floor(33 * MICROS_PER_CENT * 0.2));
  });

  it("funds nothing from nothing", () => {
    expect(poolShareMicros(0)).toBe(0);
    expect(poolShareMicros(-500)).toBe(0);
    expect(poolShareMicros(Number.NaN)).toBe(0);
  });
});

describe("what an engagement is worth", () => {
  it("pays for engagement a person chose, and pays most for the one an advertiser can act on", () => {
    expect(REWARD_MICROS.read).toBeLessThan(REWARD_MICROS.respond);
    expect(REWARD_MICROS.respond).toBeLessThan(REWARD_MICROS.follow);
  });

  it("pays nothing for an action that is not on the list", () => {
    expect(rewardFor("read")).toBe(REWARD_MICROS.read);
    expect(rewardFor("click")).toBe(0);
    expect(rewardFor("")).toBe(0);
    expect(rewardFor("__proto__")).toBe(0);
    expect(isEarnAction("follow")).toBe(true);
    expect(isEarnAction("toString")).toBe(false);
  });

  it("keeps a single day's earning under the daily cap for every action", () => {
    // If one action were worth more than the cap, the cap would never bind.
    for (const value of Object.values(REWARD_MICROS)) {
      expect(value).toBeLessThan(DAILY_MICROS_CAP);
    }
  });
});

describe("dwell", () => {
  it("clamps a claimed dwell to something a browser could honestly report", () => {
    expect(cleanDwell(12_000)).toBe(12_000);
    expect(cleanDwell(MAX_DWELL_MS * 10)).toBe(MAX_DWELL_MS);
    expect(cleanDwell(-1)).toBe(0);
    expect(cleanDwell("nonsense")).toBe(0);
    expect(cleanDwell(null)).toBe(0);
  });

  it("asks for real time in view before a read counts", () => {
    // A view alone pays nothing: paying per impression is what makes a farm
    // worth building.
    expect(MIN_READ_DWELL_MS).toBeGreaterThanOrEqual(5_000);
    expect(cleanDwell(MIN_READ_DWELL_MS - 1)).toBeLessThan(MIN_READ_DWELL_MS);
  });
});

describe("withdrawing", () => {
  it("floors to whole cents and leaves the remainder on the balance", () => {
    expect(withdrawableCents(25_500)).toBe(2);
    expect(withdrawableCents(9_999)).toBe(0);
    expect(withdrawableCents(0)).toBe(0);
    expect(withdrawableCents(-1)).toBe(0);
  });

  it("holds a balance until it is worth the payout fee", () => {
    expect(canWithdraw(MIN_PAYOUT_CENTS * MICROS_PER_CENT)).toBe(true);
    expect(canWithdraw(MIN_PAYOUT_CENTS * MICROS_PER_CENT - 1)).toBe(false);
  });

  it("would take many capped days to reach the minimum, which is the point", () => {
    // A farm that beats every other control still has to wait, and waiting is
    // a cost. At the daily cap this is weeks per account.
    const daysToMinimum = (MIN_PAYOUT_CENTS * MICROS_PER_CENT) / DAILY_MICROS_CAP;
    expect(daysToMinimum).toBeGreaterThan(30);
  });
});

describe("probation", () => {
  it("accrues from day one but cannot withdraw for a week", () => {
    const now = new Date("2026-09-20T00:00:00Z");
    expect(probationCleared("2026-09-01T00:00:00Z", now)).toBe(true);
    expect(probationCleared("2026-09-19T00:00:00Z", now)).toBe(false);
  });

  it("treats an unreadable date as still on probation", () => {
    expect(probationCleared("not a date")).toBe(false);
  });
});

describe("showing an amount", () => {
  it("keeps the digits of a sub-cent reward instead of rounding it to zero", () => {
    expect(formatMicros(REWARD_MICROS.read)).toBe("$0.0005");
    expect(formatMicros(0)).toBe("$0.00");
    expect(formatMicros(1_250_000)).toBe("$1.25");
  });
});
