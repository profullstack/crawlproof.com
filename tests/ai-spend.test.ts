import { describe, it, expect } from "vitest";
import { costMicros, formatUsd, rateFor } from "@/lib/ai/spend";

describe("rateFor", () => {
  it("prices a model the API returns with a date suffix", () => {
    // The request asks for claude-haiku-4-5; the response says
    // claude-haiku-4-5-20251001. Exact-match lookup would price it at zero.
    expect(rateFor("claude-haiku-4-5-20251001")).toEqual(rateFor("claude-haiku-4-5"));
  });

  it("prefers the longest matching prefix", () => {
    // claude-opus-5 must not be priced as some shorter claude-opus entry.
    expect(rateFor("claude-opus-5")?.output).toBe(25_000_000);
  });

  it("returns null for a model it does not know", () => {
    expect(rateFor("some-model-we-never-added")).toBeNull();
  });
});

describe("costMicros", () => {
  it("prices a Haiku draft at the published rate", () => {
    // 600 in @ $1/MTok = $0.0006; 250 out @ $5/MTok = $0.00125. Total
    // $0.00185 → 1850 micro-dollars.
    const { micros } = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 600,
      outputTokens: 250,
    });
    expect(micros).toBe(1850);
  });

  it("keeps sub-cent calls from rounding to nothing", () => {
    // The reason the ledger is in micro-dollars: in whole cents this is 0,
    // and a day of them would report as $0.00.
    const { micros } = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(micros).toBeGreaterThan(0);
    expect(micros).toBeLessThan(10_000); // under one cent
  });

  it("bills cache reads far below fresh input", () => {
    const fresh = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 10_000,
      outputTokens: 0,
    }).micros;
    const cached = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      cacheReadTokens: 10_000,
      outputTokens: 0,
    }).micros;
    expect(cached).toBeLessThan(fresh);
    expect(cached).toBeCloseTo(fresh * 0.1, -1);
  });

  it("bills cache writes above fresh input", () => {
    const fresh = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 10_000,
      outputTokens: 0,
    }).micros;
    const written = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      cacheWriteTokens: 10_000,
      outputTokens: 0,
    }).micros;
    expect(written).toBeGreaterThan(fresh);
  });

  it("costs an unknown model zero and says the rate was unknown", () => {
    // Reporting zero silently would understate a bill; the null rate is what
    // makes that visible in the stored row.
    const { micros, rate } = costMicros({
      provider: "anthropic",
      model: "brand-new-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(micros).toBe(0);
    expect(rate).toBeNull();
  });

  it("prices output above input, as every model does", () => {
    const inputOnly = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1000,
      outputTokens: 0,
    }).micros;
    const outputOnly = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 0,
      outputTokens: 1000,
    }).micros;
    expect(outputOnly).toBeGreaterThan(inputOnly);
  });
});

describe("formatUsd", () => {
  it("renders micro-dollars as money", () => {
    expect(formatUsd(15_000_000)).toBe("$15.00");
    expect(formatUsd(1850)).toBe("$0.00");
    expect(formatUsd(18_432_100)).toBe("$18.43");
  });
});

describe("the threshold in practice", () => {
  it("takes a lot of Haiku drafts to reach $15", () => {
    // Sanity on the alert being meaningful rather than hair-trigger: at the
    // measured ~$0.00185 per draft, $15/day is thousands of drafts.
    const perDraft = costMicros({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 600,
      outputTokens: 250,
    }).micros;
    const draftsToThreshold = Math.round(15_000_000 / perDraft);
    expect(draftsToThreshold).toBeGreaterThan(5_000);
  });
});
