import { afterEach, describe, expect, it, vi } from "vitest";

// The salt is read through lib/env at call time, so each test sets the env var
// and re-imports the module with a fresh registry.
async function loadIpHash(salt: string | undefined) {
  vi.resetModules();
  if (salt === undefined) delete process.env.IP_HASH_SALT;
  else process.env.IP_HASH_SALT = salt;
  return import("@/lib/ipHash");
}

const ORIGINAL = process.env.IP_HASH_SALT;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.IP_HASH_SALT;
  else process.env.IP_HASH_SALT = ORIGINAL;
  vi.resetModules();
});

describe("hashIp (stable)", () => {
  it("changes the digest when the salt changes", async () => {
    const a = (await loadIpHash("salt-one")).hashIp("203.0.113.7");
    const b = (await loadIpHash("salt-two")).hashIp("203.0.113.7");
    expect(a).not.toEqual(b);
  });

  it("is stable across calls and across days for a given salt", async () => {
    const { hashIp } = await loadIpHash("salt-one");
    // Abuse caps look back 24h+; the stable variant must not drift with time,
    // or every anonymous quota would refill at the rotation boundary.
    expect(hashIp("203.0.113.7")).toEqual(hashIp("203.0.113.7"));
  });

  it("buckets a missing IP rather than returning null", async () => {
    const { hashIp } = await loadIpHash("salt-one");
    // Conservative for rate limiting: unattributable requests share a bucket.
    expect(hashIp(null)).toEqual(hashIp(undefined));
    expect(typeof hashIp(null)).toBe("string");
  });

  it("reproduces the legacy unsalted digest when no salt is configured", async () => {
    // An env that hasn't set IP_HASH_SALT yet must not silently invalidate every
    // stored hash and hand each rate-limited visitor a fresh quota.
    const crypto = await import("node:crypto");
    const legacy = crypto
      .createHash("sha256")
      .update("crawlproof:203.0.113.7")
      .digest("hex")
      .slice(0, 32);
    const { hashIp } = await loadIpHash(undefined);
    expect(hashIp("203.0.113.7")).toEqual(legacy);
  });
});

describe("hashIpRotating", () => {
  it("returns null for a missing IP instead of a shared bucket", async () => {
    const { hashIpRotating } = await loadIpHash("salt-one");
    // Load-bearing: one shared hash for every unattributable ad request would
    // make them all look like duplicates and invalidate legitimate clicks.
    expect(hashIpRotating(null)).toBeNull();
    expect(hashIpRotating("")).toBeNull();
  });

  it("gives the same IP a different hash on a different day", async () => {
    const { hashIpRotating } = await loadIpHash("salt-one");
    const day1 = hashIpRotating("203.0.113.7", new Date("2026-08-10T12:00:00Z"));
    const day2 = hashIpRotating("203.0.113.7", new Date("2026-08-11T12:00:00Z"));
    expect(day1).not.toEqual(day2);
  });

  it("is stable within the same day", async () => {
    const { hashIpRotating } = await loadIpHash("salt-one");
    const morning = hashIpRotating("203.0.113.7", new Date("2026-08-10T01:00:00Z"));
    const evening = hashIpRotating("203.0.113.7", new Date("2026-08-10T23:00:00Z"));
    expect(morning).toEqual(evening);
  });

  it("differs from the stable hash, so the two can't be cross-correlated", async () => {
    const { hashIp, hashIpRotating } = await loadIpHash("salt-one");
    expect(hashIpRotating("203.0.113.7")).not.toEqual(hashIp("203.0.113.7"));
  });
});

describe("rotatingIpHashCandidates", () => {
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  it("returns only today's hash when the window doesn't cross a rotation", async () => {
    const { rotatingIpHashCandidates } = await loadIpHash("salt-one");
    const at = new Date("2026-08-10T12:00:00Z");
    expect(rotatingIpHashCandidates("203.0.113.7", SIX_HOURS, at)).toHaveLength(1);
  });

  it("includes yesterday's hash when the window crosses the boundary", async () => {
    const { hashIpRotating, rotatingIpHashCandidates } = await loadIpHash("salt-one");
    // 02:00 looking back 6h reaches into the previous salt window. Without this
    // the dedupe check silently misses for the first hours of every day.
    const at = new Date("2026-08-10T02:00:00Z");
    const candidates = rotatingIpHashCandidates("203.0.113.7", SIX_HOURS, at);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual(hashIpRotating("203.0.113.7", at));
    expect(candidates).toContain(
      hashIpRotating("203.0.113.7", new Date("2026-08-09T22:00:00Z")),
    );
  });

  it("returns nothing for a missing IP", async () => {
    const { rotatingIpHashCandidates } = await loadIpHash("salt-one");
    expect(rotatingIpHashCandidates(null, SIX_HOURS)).toEqual([]);
  });

  it("yields hex-only values safe to interpolate into a PostgREST filter", async () => {
    const { rotatingIpHashCandidates } = await loadIpHash("salt-one");
    for (const h of rotatingIpHashCandidates("203.0.113.7", SIX_HOURS)) {
      expect(h).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});
