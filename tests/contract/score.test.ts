import { describe, it, expect } from "vitest";
import { scoreFindings } from "@/lib/audit/score";
import type { Finding } from "@/lib/audit/types";

const F = (over: Partial<Finding> = {}): Finding => ({
  section: "Homepage Audit",
  check_key: "x",
  status: "pass",
  title: "t",
  priority: 5,
  ...over,
});

describe("scoreFindings", () => {
  it("returns 0 when there are no findings", () => {
    expect(scoreFindings([])).toBe(0);
  });

  it("returns 100 when every finding passes", () => {
    expect(
      scoreFindings([
        F({ priority: 1, status: "pass" }),
        F({ priority: 3, status: "pass" }),
        F({ priority: 5, status: "pass" }),
      ]),
    ).toBe(100);
  });

  it("returns 0 when every finding fails", () => {
    expect(
      scoreFindings([
        F({ priority: 1, status: "fail" }),
        F({ priority: 3, status: "fail" }),
      ]),
    ).toBe(0);
  });

  it("a single P1 fail outweighs many P5 passes", () => {
    const score = scoreFindings([
      F({ priority: 1, status: "fail" }),
      F({ priority: 5, status: "pass" }),
      F({ priority: 5, status: "pass" }),
      F({ priority: 5, status: "pass" }),
    ]);
    expect(score).toBeLessThan(50);
  });

  it("warns count as half-credit", () => {
    const allWarn = scoreFindings([
      F({ priority: 3, status: "warn" }),
      F({ priority: 3, status: "warn" }),
    ]);
    expect(allWarn).toBe(50);
  });

  it("returns an integer in [0, 100]", () => {
    const s = scoreFindings([
      F({ priority: 1, status: "fail" }),
      F({ priority: 2, status: "warn" }),
      F({ priority: 3, status: "pass" }),
      F({ priority: 4, status: "unknown" }),
      F({ priority: 5, status: "pass" }),
    ]);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});
