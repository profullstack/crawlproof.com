/**
 * The risk-to-viral score.
 *
 * Two things are being pinned here. The first is that the arithmetic means what
 * the comment in lib/dashboard/score.ts says it means — growth raises a score,
 * crawler traffic lowers it, one channel carrying everything is a risk. The
 * second is that none of it can produce a NaN, an Infinity or a confident zero
 * from missing data, because a scoreboard that ranks a dead property above a
 * live one is worse than no scoreboard.
 */
import { describe, expect, it } from "vitest";

import {
  CONCENTRATION_FLOOR,
  MIN_SAMPLE_HUMANS,
  RISK_WEIGHTS,
  TARGET_RPM_USD,
  VIRAL_WEIGHTS,
  clamp01,
  coefficientOfVariation,
  discoveryShare,
  growthRate,
  scoreSite,
  topSourceShare,
} from "@/lib/dashboard/score";

const flat = (value: number, length = 14) => Array.from({ length }, () => value);

const component = (list: { key: string; value: number | null }[], key: string) =>
  list.find((c) => c.key === key);

describe("weights", () => {
  it("each half sums to one, so the weighted mean is a mean", () => {
    const sum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum(VIRAL_WEIGHTS)).toBeCloseTo(1);
    expect(sum(RISK_WEIGHTS)).toBeCloseTo(1);
  });
});

describe("clamp01", () => {
  it("orders NaN to zero rather than propagating it", () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
  });
});

describe("growthRate", () => {
  it("compares the recent half of the window with the earlier half", () => {
    expect(growthRate([1, 1, 2, 2])).toBeCloseTo(1);
    expect(growthRate([2, 2, 1, 1])).toBeCloseTo(-0.5);
    expect(growthRate([5, 5, 5, 5])).toBeCloseTo(0);
  });

  it("treats growth from nothing as growth rather than dividing by zero", () => {
    const g = growthRate([0, 0, 3, 4]);
    expect(g).not.toBeNull();
    expect(Number.isFinite(g as number)).toBe(true);
    expect(g).toBeGreaterThan(0);
  });

  it("is null with too few buckets, or with no traffic at all", () => {
    expect(growthRate([1, 2, 3])).toBeNull();
    expect(growthRate([])).toBeNull();
    expect(growthRate([0, 0, 0, 0])).toBeNull();
  });
});

describe("coefficientOfVariation", () => {
  it("is zero for a flat series and larger for a spiky one", () => {
    expect(coefficientOfVariation(flat(10))).toBeCloseTo(0);
    const spiky = coefficientOfVariation([0, 0, 0, 0, 0, 100]);
    expect(spiky).not.toBeNull();
    expect(spiky as number).toBeGreaterThan(1);
  });

  it("is scale-free: ten visits a day and ten thousand score the same", () => {
    const small = coefficientOfVariation([1, 3, 2, 4, 2, 3]);
    const large = coefficientOfVariation([1000, 3000, 2000, 4000, 2000, 3000]);
    expect(small).toBeCloseTo(large as number);
  });

  it("is null with no mean to divide by", () => {
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
    expect(coefficientOfVariation([5, 5])).toBeNull();
  });
});

describe("discoveryShare", () => {
  it("counts channels a stranger can arrive through, not the ones we had", () => {
    const share = discoveryShare([
      { label: "Search · google", value: 40 },
      { label: "Social · reddit", value: 10 },
      { label: "Direct", value: 50 },
    ]);
    expect(share).toBeCloseTo(0.5);
  });

  it("reads the bucket spelling as well as the rendered label", () => {
    expect(discoveryShare([{ label: "ai_referral:chatgpt", value: 3 }])).toBeCloseTo(1);
    expect(discoveryShare([{ label: "AI · chatgpt", value: 3 }])).toBeCloseTo(1);
  });

  it("is null rather than zero when nothing arrived", () => {
    expect(discoveryShare([])).toBeNull();
    expect(discoveryShare(undefined)).toBeNull();
    expect(discoveryShare([{ label: "Direct", value: 0 }])).toBeNull();
  });
});

describe("topSourceShare", () => {
  it("is the largest channel's share of everything", () => {
    expect(topSourceShare([{ label: "a", value: 9 }, { label: "b", value: 1 }])).toBeCloseTo(0.9);
    expect(topSourceShare([{ label: "a", value: 1 }])).toBeCloseTo(1);
    expect(topSourceShare([])).toBeNull();
  });
});

describe("scoreSite", () => {
  const growing = () => ({
    humans: [5, 5, 6, 6, 10, 12, 14, 16],
    bots: [1, 1, 1, 1, 1, 1, 1, 1],
    sources: [
      { label: "Search · google", value: 40 },
      { label: "Social · reddit", value: 30 },
      { label: "Direct", value: 30 },
    ],
    mixKnown: true,
  });

  it("scores a growing, human, well-spread property above a shrinking one", () => {
    const up = scoreSite(growing());
    const down = scoreSite({ ...growing(), humans: [16, 14, 12, 10, 6, 6, 5, 5] });
    expect(up.score).not.toBeNull();
    expect(down.score).not.toBeNull();
    expect(up.score as number).toBeGreaterThan(down.score as number);
  });

  it("keeps every score inside 0..100", () => {
    for (const input of [
      growing(),
      { humans: [] },
      { humans: flat(0) },
      { humans: [1e12, 1e12, 0, 0], bots: flat(1e12), mixKnown: true },
      { humans: flat(5), revenueUsd: 1e9, mixKnown: true },
    ]) {
      const model = scoreSite(input);
      if (model.score === null) continue;
      expect(model.score).toBeGreaterThanOrEqual(0);
      expect(model.score).toBeLessThanOrEqual(100);
    }
  });

  it("marks a mostly-crawler property down through humanity and bot dependence", () => {
    const human = scoreSite(growing());
    const crawled = scoreSite({ ...growing(), bots: [500, 500, 500, 500, 500, 500, 500, 500] });
    expect(component(crawled.viralComponents, "humanity")?.value as number).toBeLessThan(0.1);
    expect(component(crawled.riskComponents, "botDependence")?.value as number).toBeGreaterThan(0.9);
    expect(crawled.score as number).toBeLessThan(human.score as number);
  });

  it("does not assume a 100% human property when the mix was never measured", () => {
    const model = scoreSite({ ...growing(), bots: [], mixKnown: false });
    expect(component(model.viralComponents, "humanity")?.value).toBeNull();
    expect(component(model.riskComponents, "botDependence")?.value).toBeNull();
    expect(model.notes.join(" ")).toMatch(/unknown/i);
    // Dropped, not zeroed: the remaining weight still adds up to a mean.
    expect(model.coverage).toBeLessThan(1);
    expect(model.score).not.toBeNull();
  });

  it("treats one channel carrying everything as a risk, an even split as none", () => {
    const oneChannel = scoreSite({
      ...growing(),
      sources: [{ label: "Search · google", value: 100 }],
    });
    const spread = scoreSite({
      ...growing(),
      sources: [
        { label: "Search · google", value: 34 },
        { label: "Social · reddit", value: 33 },
        { label: "Referral · news.ycombinator.com", value: 33 },
      ],
    });
    expect(component(oneChannel.riskComponents, "concentration")?.value).toBeCloseTo(1);
    expect(component(spread.riskComponents, "concentration")?.value).toBeCloseTo(0);
    expect(spread.score as number).toBeGreaterThan(oneChannel.score as number);
  });

  it("puts the concentration floor where an even-ish split stops counting", () => {
    const atFloor = scoreSite({
      ...growing(),
      sources: [
        { label: "Search · google", value: CONCENTRATION_FLOOR * 100 },
        { label: "Direct", value: (1 - CONCENTRATION_FLOOR) * 100 },
      ],
    });
    expect(component(atFloor.riskComponents, "concentration")?.value).toBeCloseTo(0);
  });

  it("scores money against the target RPM and caps it there", () => {
    const humans = 1000;
    const atTarget = scoreSite({ humans: flat(humans / 14), revenueUsd: TARGET_RPM_USD, mixKnown: true });
    const over = scoreSite({ humans: flat(humans / 14), revenueUsd: TARGET_RPM_USD * 50, mixKnown: true });
    expect(component(atTarget.viralComponents, "money")?.value).toBeCloseTo(1, 1);
    expect(component(over.viralComponents, "money")?.value).toBe(1);
    expect(component(over.riskComponents, "unmonetised")?.value).toBe(0);
  });

  it("flags a sample too small to lean on without hiding the number", () => {
    const tiny = scoreSite({ humans: [1, 1, 2, 1], mixKnown: true, bots: [0, 0, 0, 0] });
    expect(tiny.provisional).toBe(true);
    expect(tiny.humans).toBeLessThan(MIN_SAMPLE_HUMANS);
    expect(tiny.score).not.toBeNull();
    expect(tiny.notes.join(" ")).toContain(String(MIN_SAMPLE_HUMANS));
  });

  it("prefers the unfiltered totals when the series only counted one side", () => {
    // What `who=bots` looks like: the human column is zero by construction, and
    // the mix knows the real split.
    const model = scoreSite({
      humans: flat(0),
      bots: flat(10),
      humansTotal: 900,
      botsTotal: 100,
      mixKnown: true,
    });
    expect(model.humans).toBe(900);
    expect(component(model.viralComponents, "humanity")?.value).toBeCloseTo(0.9);
    expect(model.provisional).toBe(false);
  });

  it("returns no score at all, rather than a zero, for a property with no data", () => {
    const empty = scoreSite({ humans: [] });
    expect(empty.score).toBeNull();
    expect(empty.viral).toBe(0);
    expect(empty.risk).toBe(0);
    expect(empty.coverage).toBe(0);
  });

  it("survives junk without a NaN reaching a component", () => {
    const model = scoreSite({
      humans: [Number.NaN, Number.POSITIVE_INFINITY, 3, 4] as number[],
      bots: ["7" as unknown as number, null as unknown as number, 1, 1],
      sources: [{ label: "Search · google", value: Number.NaN }, { label: "", value: 5 }] as never,
      revenueUsd: Number.NaN,
      mixKnown: true,
    });
    const values = [...model.viralComponents, ...model.riskComponents].map((c) => c.value);
    for (const v of values) expect(v === null || Number.isFinite(v)).toBe(true);
    expect(model.score === null || Number.isFinite(model.score)).toBe(true);
  });
});
