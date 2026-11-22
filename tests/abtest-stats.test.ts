import { describe, expect, it } from "vitest";
import {
  assignArm,
  bucket,
  createClient,
  normalCdf,
  normalQuantile,
  probabilityToBeat,
  sampleSizePerArm,
  summarize,
  twoProportionZ,
  wilson,
} from "@/packages/abtest/src";
import { AbError, parseEvent, parseExperimentDef } from "@/lib/abtest/store";

describe("normal distribution", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5);
  });
});

describe("wilson", () => {
  it("pins the edges to the observed rate", () => {
    expect(wilson(0, 50).low).toBe(0);
    expect(wilson(50, 50).high).toBe(1);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });
  it("brackets the rate", () => {
    const ci = wilson(10, 100);
    expect(ci.low).toBeCloseTo(0.0552, 3);
    expect(ci.high).toBeCloseTo(0.1744, 3);
  });
});

describe("two-proportion z test", () => {
  it("finds a big gap and ignores no gap", () => {
    const r = twoProportionZ(20, 1000, 45, 1000);
    expect(r.z).toBeGreaterThan(3);
    expect(r.pValue).toBeLessThan(0.01);
    expect(twoProportionZ(10, 100, 10, 100).pValue).toBeCloseTo(1, 6);
    expect(twoProportionZ(0, 0, 0, 0).pValue).toBe(1);
  });
});

describe("probability to beat", () => {
  it("is 0.5 for identical data and agrees with the direction", () => {
    expect(probabilityToBeat(10, 100, 10, 100)).toBeCloseTo(0.5, 3);
    expect(probabilityToBeat(10, 100, 30, 100)).toBeGreaterThan(0.99);
    expect(probabilityToBeat(30, 100, 10, 100)).toBeLessThan(0.01);
  });
  it("matches a known exact value", () => {
    // Beta(2,9) vs Beta(5,6): P(B > A) = 0.92957 (Monte Carlo, 400k draws: 0.9291).
    expect(probabilityToBeat(1, 9, 4, 9)).toBeCloseTo(0.92957, 4);
  });
  it("uses the normal approximation for huge counts", () => {
    const p = probabilityToBeat(30_000, 1_000_000, 31_000, 1_000_000);
    expect(p).toBeGreaterThan(0.99);
  });
});

describe("sample size", () => {
  it("matches the textbook figure", () => {
    // 10% vs 15%, alpha .05 two-sided, power .8: ~686 per arm.
    const n = sampleSizePerArm(0.1, 0.15);
    expect(n).toBeGreaterThan(670);
    expect(n).toBeLessThan(700);
    expect(sampleSizePerArm(0.1, 0.1)).toBe(Infinity);
  });
});

describe("assignArm", () => {
  it("is deterministic and sticky", () => {
    const a = assignArm("trial", "acct-1", ["30d", "90d"]);
    for (let i = 0; i < 5; i++) expect(assignArm("trial", "acct-1", ["30d", "90d"])).toBe(a);
  });
  it("splits roughly evenly and honours weights", () => {
    const n = 20_000;
    let even = 0;
    let weighted = 0;
    for (let i = 0; i < n; i++) {
      if (assignArm("exp", `u${i}`, ["a", "b"]) === "a") even++;
      if (assignArm("exp", `u${i}`, [{ key: "a", weight: 1 }, { key: "b", weight: 3 }]) === "a") weighted++;
    }
    expect(even / n).toBeGreaterThan(0.48);
    expect(even / n).toBeLessThan(0.52);
    expect(weighted / n).toBeGreaterThan(0.23);
    expect(weighted / n).toBeLessThan(0.27);
  });
  it("differs across experiments", () => {
    let same = 0;
    for (let i = 0; i < 2000; i++) if ((bucket("x", `u${i}`) < 0.5) === (bucket("y", `u${i}`) < 0.5)) same++;
    expect(same / 2000).toBeGreaterThan(0.45);
    expect(same / 2000).toBeLessThan(0.55);
  });
  it("refuses bad arms", () => {
    expect(() => assignArm("e", "u", ["a"])).toThrow();
    expect(() => assignArm("e", "u", ["a", "a"])).toThrow();
    expect(() => assignArm("e", "u", [{ key: "a", weight: 0 }, "b"])).toThrow();
  });
});

describe("summarize", () => {
  it("collects until every arm has the minimum", () => {
    const s = summarize([{ arm: "90d", exposed: 50, converted: 5 }, { arm: "30d", exposed: 200, converted: 30 }], { control: "90d" });
    expect(s.verdict.status).toBe("collecting");
    expect(s.arms[0].isControl).toBe(true);
    expect(s.arms[1].pValue).not.toBeNull();
  });
  it("calls a big gap", () => {
    const s = summarize(
      [
        { arm: "90d", exposed: 1000, converted: 50, revenue: 950 },
        { arm: "30d", exposed: 1000, converted: 100, revenue: 1900, events: { voice_meeting: { units: 400, count: 900 } } },
      ],
      { control: "90d" },
    );
    expect(s.verdict.status).toBe("significant");
    expect(s.verdict.winner).toBe("30d");
    expect(s.arms[1].lift).toBeCloseTo(1, 6);
    expect(s.arms[1].revenuePerExposed).toBeCloseTo(1.9, 6);
    expect(s.arms[1].events.voice_meeting.perExposed).toBeCloseTo(0.9, 6);
  });
  it("names the control as winner when the challenger is significantly worse", () => {
    const s = summarize([{ arm: "90d", exposed: 1000, converted: 100 }, { arm: "30d", exposed: 1000, converted: 40 }], { control: "90d" });
    expect(s.verdict.winner).toBe("90d");
  });
  it("says keep running with the needed sample for a small gap", () => {
    const s = summarize([{ arm: "a", exposed: 300, converted: 30 }, { arm: "b", exposed: 300, converted: 36 }]);
    expect(s.verdict.status).toBe("keep-running");
    expect(s.verdict.neededPerArm).toBeGreaterThan(300);
    expect(s.verdict.text).toMatch(/Keep running/);
  });
  it("reports no difference on equal rates", () => {
    const s = summarize([{ arm: "a", exposed: 300, converted: 30 }, { arm: "b", exposed: 300, converted: 30 }]);
    expect(s.verdict.status).toBe("no-difference");
  });
});

describe("client", () => {
  it("falls back to the same arm offline and never throws when failOpen", async () => {
    const ab = createClient({ token: "crp_x", baseUrl: "http://127.0.0.1:9", timeoutMs: 200, fetch: (() => Promise.reject(new Error("down"))) as typeof fetch });
    const r = await ab.assign("trial", "acct-1", ["30d", "90d"]);
    expect(r.offline).toBe(true);
    expect(r.arm).toBe(assignArm("trial", "acct-1", ["30d", "90d"]));
    const t = await ab.exposure("trial", "acct-1");
    expect(t.ok).toBe(false);
  });
  it("sends bearer + JSON to the API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ arm: "90d", new: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const ab = createClient({ token: "crp_t", baseUrl: "https://cp.test/", fetch: fake });
    const r = await ab.assign("trial", "u1");
    expect(r).toEqual({ arm: "90d", new: true });
    expect(calls[0].url).toBe("https://cp.test/api/abtest/v1/assign");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer crp_t");
    await ab.revenue("trial", "u1", 19, { id: "p1" });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ experiment: "trial", unit: "u1", type: "revenue", value: 19, id: "p1" });
  });
});

describe("store validation", () => {
  it("parses an experiment definition", () => {
    const d = parseExperimentDef({ key: "board-saas.voice-trial", arms: [{ key: "90d", label: "90 days" }, "30d"], control: "90d" });
    expect(d.arms).toEqual([{ key: "90d", label: "90 days", weight: 1 }, { key: "30d", label: "30d", weight: 1 }]);
    expect(d.control).toBe("90d");
    expect(d.min_per_arm).toBe(100);
  });
  it("rejects bad definitions", () => {
    expect(() => parseExperimentDef({ key: "Bad Key", arms: ["a", "b"] })).toThrow(AbError);
    expect(() => parseExperimentDef({ key: "k", arms: ["a"] })).toThrow(AbError);
    expect(() => parseExperimentDef({ key: "k", arms: ["a", "b"], control: "c" })).toThrow(AbError);
  });
  it("validates events", () => {
    expect(parseEvent({ type: "exposure" })).toEqual({ type: "exposure", name: null, value: null, dedupe: null });
    expect(() => parseEvent({ type: "event" })).toThrow(/needs a name/);
    expect(() => parseEvent({ type: "revenue" })).toThrow(/needs a value/);
    expect(() => parseEvent({ type: "click" })).toThrow(AbError);
    expect(parseEvent({ type: "revenue", value: "19", id: "p1" })).toEqual({ type: "revenue", name: null, value: 19, dedupe: "p1" });
  });
});
