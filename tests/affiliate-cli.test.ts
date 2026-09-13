import { describe, expect, it } from "vitest";
import { affiliateJoinBodyFromArgs, conversionLine, parseArgs } from "@/cli/index";

describe("crawlproof affiliate", () => {
  it("join body from flags", () => {
    expect(affiliateJoinBodyFromArgs(parseArgs(["affiliate", "join", "nichedb.dev"]))).toEqual({ origin: "nichedb.dev" });
    expect(affiliateJoinBodyFromArgs(parseArgs(["affiliate", "join", "https://nichedb.dev", "--program=partners", "--code", "chovy"]))).toEqual({
      origin: "https://nichedb.dev",
      program: "partners",
      code: "chovy",
    });
  });
  it("conversion lines carry the hold and the reason", () => {
    expect(conversionLine({ at: "2026-09-12T14:02:11Z", event: "sale", amount: 49, commission: 14.7, status: "pending", held_until: "2026-10-12T14:02:11Z" })).toBe(
      "2026-09-12  sale         $   49.00  → $  14.70  pending until 2026-10-12",
    );
    expect(conversionLine({ at: "2026-08-30T09:15:00Z", event: "sale", amount: 29, commission: 8.7, status: "reversed", reason: "refunded 2026-09-04" })).toContain("(refunded 2026-09-04)");
  });
});
