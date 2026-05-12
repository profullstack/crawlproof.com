import { describe, it, expect } from "vitest";
import { CREDIT_PACKS, dollars, findPack } from "@/lib/credits";

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
    expect(findPack("pack-1")?.credits).toBe(1);
    expect(findPack("nonexistent")).toBeUndefined();
  });

  it("dollars formats whole-dollar prices without decimals", () => {
    expect(dollars(100)).toBe("$1");
    expect(dollars(5000)).toBe("$50");
    expect(dollars(10000)).toBe("$100");
  });
});
