import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { scoreIntent } from "@/lib/outreach/intent";
import { acceptsRelevance, MIN_RELEVANCE_CONFIDENCE } from "@/lib/outreach/intentRelevance";

const NOW = new Date("2026-07-28T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// The request a keyword campaign misses: somebody with the problem, describing
// the problem, using none of the words for the product that solves it.
const OFF_VOCAB = "Our checkout keeps timing out whenever we run a promo. Anyone recommend a fix?";

describe("keyword misses are not verdicts", () => {
  it("still drops an off-keyword post when there is nothing to judge against", () => {
    // Without a description the keyword gate is the only gate there is, and
    // removing it would simply widen the funnel.
    const s = scoreIntent({
      text: OFF_VOCAB,
      postedAt: ago(2),
      keywords: ["load testing"],
      now: NOW,
    });
    expect(s.disqualified).toMatch(/no campaign keyword/);
  });

  it("holds it open for judgement when a description exists", () => {
    const s = scoreIntent({
      text: OFF_VOCAB,
      postedAt: ago(2),
      keywords: ["load testing"],
      allowDescriptionMatch: true,
      now: NOW,
    });
    expect(s.disqualified).toBeNull();
    // Null means undecided, never off-topic — that is what disqualified is for.
    expect(s.matchPath).toBeNull();
    expect(s.score).toBeGreaterThan(0);
  });

  it("marks a keyword hit as such without needing a judgement", () => {
    const s = scoreIntent({
      text: "Anyone recommend a load testing tool?",
      postedAt: ago(2),
      keywords: ["load testing"],
      allowDescriptionMatch: true,
      now: NOW,
    });
    expect(s.matchPath).toBe("keyword");
  });

  it("does not let the description path rescue a stated no", () => {
    // A relevance judgement is not entitled to overturn "no vendors".
    const s = scoreIntent({
      text: "Our checkout times out. No vendors please.",
      postedAt: ago(2),
      keywords: ["load testing"],
      allowDescriptionMatch: true,
      now: NOW,
    });
    expect(s.disqualified).toMatch(/pitched/);
  });

  it("does not let it rescue somebody selling", () => {
    const s = scoreIntent({
      text: "I fix checkout timeouts — DM me for rates.",
      postedAt: ago(2),
      keywords: ["load testing"],
      allowDescriptionMatch: true,
      now: NOW,
    });
    expect(s.disqualified).toMatch(/selling/);
  });
});

describe("a guess is not a reason to contact somebody", () => {
  it("requires the model to be sure", () => {
    expect(acceptsRelevance({ relevant: true, confidence: MIN_RELEVANCE_CONFIDENCE, reason: "x" })).toBe(true);
    expect(acceptsRelevance({ relevant: true, confidence: MIN_RELEVANCE_CONFIDENCE - 1, reason: "x" })).toBe(false);
  });

  it("takes a no as a no however confident", () => {
    expect(acceptsRelevance({ relevant: false, confidence: 100, reason: "x" })).toBe(false);
  });

  it("treats a missing verdict as no match, not as a rejection", () => {
    // A missing model must narrow nothing: the keyword path still stands, and
    // the sweep simply does not gain the extra signals.
    expect(acceptsRelevance(null)).toBe(false);
  });
});

describe("the alert is wired and bounded", () => {
  const runner = readFileSync(new URL("../lib/outreach/runner.ts", import.meta.url), "utf8");
  const sources = readFileSync(new URL("../lib/outreach/intentSources.ts", import.meta.url), "utf8");

  it("tells somebody when a signal is found", () => {
    // A signal sitting in a table until someone opens the page is
    // indistinguishable from one that was never found.
    expect(runner).toContain("alertNewIntent");
    expect(runner).toContain("sendIntentAlertEmail");
  });

  it("never alerts the same signal twice", () => {
    expect(runner).toContain('.is("alerted_at", null)');
  });

  it("marks alerted only after the send succeeds", () => {
    // The other order loses a whole batch to one SMTP hiccup.
    const fn = runner.slice(runner.indexOf("async function alertNewIntent"));
    expect(fn.indexOf("if (!res.sent) return 0;")).toBeLessThan(fn.indexOf("alerted_at: new Date()"));
  });

  it("caps how many model judgements a sweep can make", () => {
    // An index that suddenly returns three hundred results must not become
    // three hundred model calls.
    expect(sources).toContain("MAX_RELEVANCE_JUDGEMENTS");
    expect(sources).toMatch(/judgements >= MAX_RELEVANCE_JUDGEMENTS/);
  });

  it("only judges what already cleared the score bar", () => {
    expect(sources).toMatch(/pending\.push/);
  });
});
