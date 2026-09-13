import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { CLAIM_CLICK_LUA, CLICK_COOLDOWN_MS } from "@/lib/ads/click-cooldown";

// Opt-in, disposable Redis only. Never points at the application's REDIS_URL.
const testUrl = process.env.TEST_AD_REDIS_URL;
describe.skipIf(!testUrl)("atomic click admission against Redis", () => {
  const clients = testUrl ? Array.from({ length: 8 }, () => new Redis(testUrl)) : [];
  const prefix = `test:ad-click:${randomUUID()}:`;
  const keys: string[] = [];
  const key = (name: string) => { const k = prefix + name; keys.push(k); return k; };
  afterAll(async () => {
    if (keys.length) await clients[0].del(...keys);
    await Promise.all(clients.map((c) => c.quit()));
  });
  it("admits exactly one of 32 concurrent cross-campaign clicks across connections", async () => {
    const ip = key("ip"), visitor = key("visitor");
    const accepted = await Promise.all(Array.from({ length: 32 }, (_, i) =>
      clients[i % clients.length].eval(CLAIM_CLICK_LUA, 2, ip, visitor, CLICK_COOLDOWN_MS)));
    expect(accepted.filter((n) => n === 1)).toHaveLength(1);
    expect(await clients[0].pttl(ip)).toBeGreaterThan(4_000);
    expect(await clients[0].pttl(ip)).toBeLessThanOrEqual(5_000);
    expect(await clients[1].eval(CLAIM_CLICK_LUA, 2, ip, key("rotated-visitor"), 5_000)).toBe(0);
    expect(await clients[1].eval(CLAIM_CLICK_LUA, 2, key("rotated-ip"), visitor, 5_000)).toBe(0);
    expect(await clients[1].eval(CLAIM_CLICK_LUA, 2, key("different-ip"), key("different-visitor"), 5_000)).toBe(1);
  });
  it("does not claim the other identity or extend expiry on rejection", async () => {
    const ip = key("busy-ip"), visitor = key("new-visitor");
    await clients[0].set(ip, "1", "PX", 100);
    expect(await clients[1].eval(CLAIM_CLICK_LUA, 2, ip, visitor, 5_000)).toBe(0);
    expect(await clients[0].exists(visitor)).toBe(0);
    expect(await clients[0].pttl(ip)).toBeLessThanOrEqual(100);
    await new Promise((r) => setTimeout(r, 120));
    expect(await clients[1].eval(CLAIM_CLICK_LUA, 2, ip, visitor, 5_000)).toBe(1);
  });
});
