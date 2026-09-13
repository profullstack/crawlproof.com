import { describe, expect, it } from "vitest";
import { CREDIT_PACKS, CREDIT_SERVICE_BASIS, SCAN_CREDITS, discountPct } from "@/lib/credits";
import { quoteServiceCostMarkup } from "@/lib/pricing-policy";
import { PAYS } from "@/lib/affiliate/program";

describe("400% service-cost markup", () => {
  it("means five times cost and rounds upward", () => {
    expect(quoteServiceCostMarkup(26)).toBe(130);
    expect(quoteServiceCostMarkup(4.9)).toBe(25);
    expect(quoteServiceCostMarkup(3)).toBe(15);
  });

  it.each([-1, NaN, Infinity])("rejects invalid service cost %s", (cost) => {
    expect(() => quoteServiceCostMarkup(cost)).toThrow(RangeError);
  });

  it.each(CREDIT_PACKS)("$id covers every documented service estimate after its discount", (pack) => {
    for (const basis of CREDIT_SERVICE_BASIS) {
      const revenue = pack.amountCents * basis.credits / pack.credits;
      expect(revenue).toBeGreaterThanOrEqual(5 * basis.serviceCents);
    }
  });

  it("preserves the four pack sizes and volume discounts", () => {
    expect(CREDIT_PACKS.map((p) => [p.id, p.credits, p.amountCents, discountPct(p)])).toEqual([
      ["pack-1", 20, 600, 0],
      ["pack-10", 200, 5400, 10],
      ["pack-50", 1000, 21000, 30],
      ["pack-100", 2000, 30000, 50],
    ]);
    expect(SCAN_CREDITS).toBe(20);
  });

  it("keeps the affiliate commission separate from the service-cost target", () => {
    expect(PAYS.find((p) => p.event === "sale" && p.kind === "percent")?.value).toBe(30);
  });
});
