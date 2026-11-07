import { describe, expect, it } from "vitest";
import { applyCoinpayPass, PASS_CREDITS, passFromUserinfo, passSource, type PassStore } from "@/lib/coinpay-pass";
import { CREDIT_PACKS } from "@/lib/credits";

function memoryStore() {
  const until = new Map<string, string | null>();
  const paidSources = new Set<string>();
  const balance = new Map<string, number>();
  const store: PassStore = {
    async setPassUntil(userId, sub, u) { until.set(`${userId}:${sub}`, u); },
    async grantOnce(userId, credits, source) {
      // Mirrors code_credit_grants_one_coinpay_pass_idx: one grant per source.
      if (paidSources.has(source)) return { applied: false };
      paidSources.add(source);
      balance.set(userId, (balance.get(userId) ?? 0) + credits);
      return { applied: true };
    },
  };
  return { store, until, balance };
}

const now = new Date("2026-11-07T12:00:00Z");
const until = "2026-12-07T12:00:00.000Z";
const active = () => passFromUserinfo({ pass: { active: true, expires_at: until } }, now);

describe("Profullstack Pass credits", () => {
  it("is worth the cheapest credit pack", () => {
    const cheapest = CREDIT_PACKS.reduce((a, b) => (b.amountCents < a.amountCents ? b : a));
    expect(PASS_CREDITS).toBe(cheapest.credits);
    expect(PASS_CREDITS).toBeGreaterThan(0);
    expect(passSource("s", new Date(until))).toBe(`coinpay-pass:s:${until}`);
  });

  it("pays once per pass, records pass_until, and pays again on renewal", async () => {
    const m = memoryStore();
    expect(await applyCoinpayPass(m.store, "u1", "sub1", active(), now)).toBe(true);
    expect(await applyCoinpayPass(m.store, "u1", "sub1", active(), now)).toBe(false);
    expect(m.balance.get("u1")).toBe(PASS_CREDITS);
    expect(m.until.get("u1:sub1")).toBe(until);
    const renewed = passFromUserinfo({ pass: { active: true, expires_at: "2027-01-07T12:00:00.000Z" } }, now);
    expect(await applyCoinpayPass(m.store, "u1", "sub1", renewed, now)).toBe(true);
    expect(m.balance.get("u1")).toBe(2 * PASS_CREDITS);
  });

  it("a second account linked to the same CoinPay sub gets nothing", async () => {
    const m = memoryStore();
    expect(await applyCoinpayPass(m.store, "u1", "sub1", active(), now)).toBe(true);
    expect(await applyCoinpayPass(m.store, "u2", "sub1", active(), now)).toBe(false);
    expect(m.balance.get("u2")).toBeUndefined();
  });

  it("pays nothing without an active, unexpired pass", async () => {
    const m = memoryStore();
    for (const claims of [{}, { pass: { active: false } }, { pass: { active: true } }, { pass: { active: true, expires_at: "x" } }, { pass: { active: true, expires_at: "2026-10-01T00:00:00Z" } }]) {
      expect(await applyCoinpayPass(m.store, "u3", "sub3", passFromUserinfo(claims, now), now)).toBe(false);
    }
    expect(m.balance.get("u3")).toBeUndefined();
    expect(m.until.get("u3:sub3")).toBeNull();
  });
});
