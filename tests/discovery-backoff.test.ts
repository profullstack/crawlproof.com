// The quota guard. In August 2026 three active campaigns emptied a 25,000-call
// ValueSERP plan in six days, and every search after that returned HTTP 402 —
// including the ones a human typed into the lead finder. Neither failure was
// visible as a bug: the runner was doing exactly what it was told, fifteen
// minutes at a time, on queries that had nothing left to give.
//
// These cover the two pieces that stop it recurring.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { discoveryBackoffMinutes } from "@/lib/outreach/runner";
import { SERP_CALLS_PER_MONTH, VALUESERP_MONTHLY_PLAN } from "@/lib/alerts/limits";

describe("discovery back-off", () => {
  it("does not rest a campaign that just produced something", () => {
    expect(discoveryBackoffMinutes(0)).toBe(0);
  });

  it("starts at half an hour and doubles", () => {
    expect(discoveryBackoffMinutes(1)).toBe(30);
    expect(discoveryBackoffMinutes(2)).toBe(60);
    expect(discoveryBackoffMinutes(3)).toBe(120);
    expect(discoveryBackoffMinutes(4)).toBe(240);
  });

  it("stops doubling at a day, so a tapped-out campaign still retries daily", () => {
    expect(discoveryBackoffMinutes(10)).toBe(24 * 60);
    expect(discoveryBackoffMinutes(100)).toBe(24 * 60);
  });

  // The whole point of the change. At 5 queries a tick, every 15 minutes,
  // three campaigns cost ~43k searches a month against a 25k plan; capped at
  // one pass a day they cost ~450.
  it("cuts a dry campaign from 96 passes a day to 1", () => {
    const passesPerDay = (24 * 60) / discoveryBackoffMinutes(10);
    expect(passesPerDay).toBe(1);
    const before = (24 * 60) / 15;
    expect(before).toBe(96);
  });
});

describe("per-account SERP budgets", () => {
  // The backstop that could not stop anything: a single pro account was
  // authorised for 200k calls a month out of a shared bucket of 25k.
  it("keeps every plan under the vendor plan it spends from", () => {
    for (const [plan, budget] of Object.entries(SERP_CALLS_PER_MONTH)) {
      expect(budget, `${plan} budget exceeds the ValueSERP plan`).toBeLessThanOrEqual(
        VALUESERP_MONTHLY_PLAN,
      );
    }
  });
});

describe("ValueSERP out-of-credit cooldown", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.VALUESERP_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("asks once, then answers from the cooldown instead of re-hitting a dead plan", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 402 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { searchSerp, resetSerpCreditCooldown } = await import("@/lib/alerts/valueserp");
    resetSerpCreditCooldown();

    const first = await searchSerp({ query: "web development agencies", recency: "any" });
    expect(first.ok).toBe(false);
    expect(first.error).toContain("402");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A campaign tick fires ~21 searches; without the cooldown all of them
    // would pay a round-trip to learn the same thing.
    for (let i = 0; i < 20; i++) {
      const again = await searchSerp({ query: `q${i}`, recency: "any" });
      expect(again.ok).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never bills a call it did not make", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 402 })) as unknown as typeof fetch;
    const { searchSerp, resetSerpCreditCooldown } = await import("@/lib/alerts/valueserp");
    resetSerpCreditCooldown();

    expect((await searchSerp({ query: "a", recency: "any" })).calls).toBe(0);
    expect((await searchSerp({ query: "b", recency: "any" })).calls).toBe(0);
  });
});
