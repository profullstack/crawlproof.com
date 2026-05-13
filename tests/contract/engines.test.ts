import { describe, it, expect } from "vitest";
import {
  ENGINES,
  type Engine,
  dedupeEngines,
  engineAvailable,
  engineCost,
  selectionCost,
} from "@/lib/credits";

const ALL_ENGINES: Engine[] = [
  "rule",
  "claude",
  "openai",
  "qwen",
  "kimi",
  "gemini",
  "deepseek",
  "perplexity",
];

describe("ENGINES catalog", () => {
  it("includes every engine the action accepts", () => {
    for (const e of ALL_ENGINES) {
      expect(ENGINES[e]).toBeDefined();
      expect(typeof ENGINES[e].label).toBe("string");
      expect(typeof ENGINES[e].blurb).toBe("string");
      expect(typeof ENGINES[e].cost).toBe("number");
      expect(typeof ENGINES[e].available).toBe("boolean");
    }
  });

  it("rule is the only free engine", () => {
    expect(ENGINES.rule.cost).toBe(0);
    for (const e of ALL_ENGINES) {
      if (e === "rule") continue;
      expect(ENGINES[e].cost).toBeGreaterThan(0);
    }
  });

  it("every engine in the catalog is available", () => {
    for (const e of ALL_ENGINES) {
      expect(ENGINES[e].available).toBe(true);
    }
  });
});

describe("engineCost / engineAvailable", () => {
  it("engineCost matches the catalog", () => {
    expect(engineCost("rule")).toBe(0);
    expect(engineCost("claude")).toBe(1);
    expect(engineCost("openai")).toBe(1);
  });

  it("engineAvailable reflects the available flag", () => {
    expect(engineAvailable("rule")).toBe(true);
    expect(engineAvailable("claude")).toBe(true);
    expect(engineAvailable("kimi")).toBe(true);
  });
});

describe("selectionCost", () => {
  it("returns 0 for rule-only", () => {
    expect(selectionCost(["rule"])).toBe(0);
  });

  it("sums one credit per paid engine, rule rides free", () => {
    expect(selectionCost(["rule", "claude"])).toBe(1);
    expect(selectionCost(["claude", "openai"])).toBe(2);
    expect(selectionCost(["rule", "claude", "openai", "gemini"])).toBe(3);
  });

  it("returns 0 for an empty selection", () => {
    expect(selectionCost([])).toBe(0);
  });
});

describe("dedupeEngines", () => {
  it("preserves first-seen order", () => {
    expect(dedupeEngines(["claude", "rule", "openai"])).toEqual([
      "claude",
      "rule",
      "openai",
    ]);
  });

  it("collapses duplicates", () => {
    expect(dedupeEngines(["rule", "rule", "claude", "claude"])).toEqual([
      "rule",
      "claude",
    ]);
  });

  it("drops unknown engine names without throwing", () => {
    const out = dedupeEngines([
      "rule",
      "not-an-engine" as Engine,
      "claude",
    ]);
    expect(out).toEqual(["rule", "claude"]);
  });

  it("returns empty for empty input", () => {
    expect(dedupeEngines([])).toEqual([]);
  });
});
