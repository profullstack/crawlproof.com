import { describe, it, expect } from "vitest";
import {
  MAX_CONSECUTIVE_FAILURES,
  shouldDisableAccount,
} from "@/lib/sp/accountHealth";

describe("shouldDisableAccount", () => {
  it("keeps an account in rotation through a run of transient failures", () => {
    expect(shouldDisableAccount({ consecutiveFailures: 1 })).toBe(false);
    expect(
      shouldDisableAccount({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 }),
    ).toBe(false);
  });

  it("takes it out once the failures stop looking transient", () => {
    expect(
      shouldDisableAccount({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES }),
    ).toBe(true);
  });

  it("takes it out immediately on a recognised dead session", () => {
    // A login wall is proof, not a guess — no need to burn ten attempts.
    expect(shouldDisableAccount({ consecutiveFailures: 1, sessionExpired: true })).toBe(
      true,
    );
  });

  it("would have caught the Reddit account that failed 2953 times", () => {
    // The regression this exists for: selector timeouts are not login walls, so
    // nothing flagged the account and the worker retried it for days.
    expect(shouldDisableAccount({ consecutiveFailures: 2953 })).toBe(true);
  });

  it("resets are the caller's job — a success zeroes the counter", () => {
    // Guards the contract the post paths rely on: 0 failures is always healthy.
    expect(shouldDisableAccount({ consecutiveFailures: 0 })).toBe(false);
  });
});
