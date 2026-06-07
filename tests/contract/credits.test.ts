import { describe, it, expect } from "vitest";
import {
  CREDIT_PACKS,
  SCAN_CREDITS,
  discountPct,
  dollars,
  findPack,
  perScanCents,
} from "@/lib/credits";

describe("credit packs catalog", () => {
  it("has at least one pack and every pack is well-formed", () => {
    expect(CREDIT_PACKS.length).toBeGreaterThan(0);
    for (const p of CREDIT_PACKS) {
      expect(p.id).toMatch(/^pack-/);
      expect(p.credits).toBeGreaterThan(0);
      expect(p.amountCents).toBeGreaterThan(0);
      expect(typeof p.label).toBe("string");
    }
  });

  it("all pack ids are unique", () => {
    const ids = new Set(CREDIT_PACKS.map((p) => p.id));
    expect(ids.size).toBe(CREDIT_PACKS.length);
  });

  it("findPack returns the right pack, undefined for unknown id", () => {
    expect(findPack("pack-1")?.credits).toBe(SCAN_CREDITS);
    expect(findPack("nonexistent")).toBeUndefined();
  });

  it("dollars formats whole-dollar prices without decimals", () => {
    expect(dollars(100)).toBe("$1");
    expect(dollars(5000)).toBe("$50");
    expect(dollars(10000)).toBe("$100");
  });

  it("dollars keeps decimals for non-whole-dollar amounts", () => {
    expect(dollars(3750)).toBe("$37.50");
    expect(dollars(7500)).toBe("$75");
    expect(dollars(3500)).toBe("$35");
  });

  it("discountPct is 0 for the rack-rate starter", () => {
    const starter = findPack("pack-1")!;
    expect(discountPct(starter)).toBe(0);
    expect(perScanCents(starter)).toBe(100);
  });

  it("discount increases monotonically with pack size", () => {
    const ordered = [...CREDIT_PACKS].sort((a, b) => a.credits - b.credits);
    let last = -1;
    for (const p of ordered) {
      const d = discountPct(p);
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
  });

  it("100-pack ships the big-bag 50% discount", () => {
    const big = findPack("pack-100")!;
    expect(discountPct(big)).toBe(50);
    expect(perScanCents(big)).toBe(50);
  });
});
