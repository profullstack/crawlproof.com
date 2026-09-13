import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ eval: vi.fn() }));
vi.mock("ioredis", () => ({ default: class {
  status = "ready";
  eval = mock.eval;
  on() {}
} }));
import { claimClickCooldown, CLICK_COOLDOWN_MS } from "@/lib/ads/click-cooldown";
import { adClickIp } from "@/lib/ads/client-ip";

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  mock.eval.mockReset().mockResolvedValue(1);
});
afterEach(() => vi.unstubAllEnvs());

describe("network-wide click cooldown", () => {
  it("claims both identities together for five seconds without storing raw identifiers", async () => {
    expect(await claimClickCooldown({ ip: "8.8.8.8", visitorId: "visitor-123" })).toEqual({ allowed: true });
    const [, count, ipKey, visitorKey, ttl] = mock.eval.mock.calls[0];
    expect(count).toBe(2);
    expect(ipKey).toMatch(/^ad:click:ip:[a-f0-9]{32}$/);
    expect(visitorKey).toMatch(/^ad:click:visitor:[a-f0-9]{32}$/);
    expect(ttl).toBe(5_000);
    expect(CLICK_COOLDOWN_MS).toBe(ttl);
    expect(JSON.stringify(mock.eval.mock.calls)).not.toContain("8.8.8.8");
    expect(JSON.stringify(mock.eval.mock.calls)).not.toContain("visitor-123");
  });
  it("rejects an occupied identity instead of charging another campaign", async () => {
    mock.eval.mockResolvedValue(0);
    expect(await claimClickCooldown({ ip: "8.8.8.8" })).toEqual({ allowed: false, reason: "click_cooldown" });
  });
  it("withholds charges when Redis fails or is unconfigured", async () => {
    mock.eval.mockRejectedValue(new Error("offline"));
    expect((await claimClickCooldown({ ip: "8.8.8.8" })).reason).toBe("cooldown_unavailable");
    vi.stubEnv("REDIS_URL", "");
    expect((await claimClickCooldown({ ip: "8.8.8.8" })).reason).toBe("cooldown_unavailable");
  });
  it("rejects unidentified traffic and unsafe visitor IDs", async () => {
    expect((await claimClickCooldown({})).reason).toBe("missing_identity");
    expect((await claimClickCooldown({ visitorId: "forged),filter" })).reason).toBe("missing_identity");
    expect(mock.eval).not.toHaveBeenCalled();
  });
  it("does not reset the IP bucket at UTC midnight", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-13T23:59:59Z"));
      await claimClickCooldown({ ip: "8.8.8.8" });
      vi.setSystemTime(new Date("2026-09-14T00:00:01Z"));
      await claimClickCooldown({ ip: "8.8.8.8" });
      expect(mock.eval.mock.calls[0][2]).toBe(mock.eval.mock.calls[1][2]);
    } finally { vi.useRealTimers(); }
  });
});

describe("Railway click identity", () => {
  it("cannot be overridden by caller-controlled forwarded headers", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "production");
    expect(adClickIp(new Headers({
      "x-real-ip": "8.8.8.8", "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9",
    }))).toBe("8.8.8.8");
  });
  it("does not fall back to a forged header when the trusted identity is missing", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "production");
    expect(adClickIp(new Headers({ "cf-connecting-ip": "1.1.1.1" }))).toBeNull();
  });
});
