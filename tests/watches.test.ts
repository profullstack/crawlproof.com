import { describe, it, expect } from "vitest";
import {
  MAX_WATCHES_PER_EMAIL,
  WATCH_MIN_DELTA,
  isWatchCadence,
  isWatchEngine,
  nextRunAt,
  normalizeWatchEmail,
  watchScoreOf,
  watchSubject,
  watchVerdict,
} from "@/lib/watches";

describe("normalizeWatchEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeWatchEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("rejects addresses that cannot receive a confirmation", () => {
    for (const bad of ["", "nope", "a@b", "two@@at.com", "has space@x.com", "@x.com", "a@"]) {
      expect(normalizeWatchEmail(bad)).toBeNull();
    }
  });

  it("rejects absurdly long input", () => {
    expect(normalizeWatchEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("cadence and engine guards", () => {
  it("accepts only the two cadences", () => {
    expect(isWatchCadence("weekly")).toBe(true);
    expect(isWatchCadence("monthly")).toBe(true);
    expect(isWatchCadence("hourly")).toBe(false);
    expect(isWatchCadence(undefined)).toBe(false);
  });

  it("accepts only the free self-hosted engines", () => {
    // A watch is recurring, so allowing a paid engine here would bill an
    // address we never charged, forever.
    expect(isWatchEngine("rule")).toBe(true);
    expect(isWatchEngine("slop")).toBe(true);
    for (const paid of ["claude", "openai", "gemini", "perplexity"]) {
      expect(isWatchEngine(paid)).toBe(false);
    }
  });
});

describe("nextRunAt", () => {
  const from = new Date("2026-07-26T00:00:00.000Z");

  it("schedules a week out", () => {
    expect(nextRunAt("weekly", from).toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("schedules 30 days out for monthly", () => {
    expect(nextRunAt("monthly", from).toISOString()).toBe("2026-08-25T00:00:00.000Z");
  });
});

describe("watchVerdict", () => {
  it("always notifies on the first completed scan", () => {
    const v = watchVerdict({ engineKind: "aeo", previousScore: null, nextScore: 61 });
    expect(v).toMatchObject({ notify: true, kind: "first", delta: 0 });
  });

  it("stays quiet on sub-threshold jitter", () => {
    const v = watchVerdict({ engineKind: "aeo", previousScore: 60, nextScore: 61 });
    expect(v.notify).toBe(false);
    expect(v.kind).toBe("unchanged");
    // Guard the constant itself: raising it silently would mute real changes.
    expect(WATCH_MIN_DELTA).toBe(2);
  });

  it("notifies once the change is real", () => {
    const v = watchVerdict({ engineKind: "aeo", previousScore: 60, nextScore: 64 });
    expect(v).toMatchObject({ notify: true, kind: "improved", delta: 4, improved: true });
  });

  it("reads a falling AEO score as worse", () => {
    const v = watchVerdict({ engineKind: "aeo", previousScore: 70, nextScore: 55 });
    expect(v).toMatchObject({ kind: "worsened", improved: false, delta: -15 });
  });

  it("reads a FALLING slop score as better", () => {
    // The inversion that matters most: 60 → 40 slop is good news, and an
    // email saying "your score dropped" would read as the opposite.
    const v = watchVerdict({ engineKind: "slop", previousScore: 60, nextScore: 40 });
    expect(v).toMatchObject({ kind: "improved", improved: true, delta: -20 });
  });

  it("reads a RISING slop score as worse", () => {
    const v = watchVerdict({ engineKind: "slop", previousScore: 20, nextScore: 45 });
    expect(v).toMatchObject({ kind: "worsened", improved: false, delta: 25 });
  });

  it("judges the same movement oppositely for the two engines", () => {
    const move = { previousScore: 30, nextScore: 50 };
    expect(watchVerdict({ engineKind: "aeo", ...move }).improved).toBe(true);
    expect(watchVerdict({ engineKind: "slop", ...move }).improved).toBe(false);
  });
});

describe("watchSubject", () => {
  it("announces the baseline on the first scan", () => {
    const verdict = watchVerdict({ engineKind: "slop", previousScore: null, nextScore: 34 });
    expect(watchSubject({ host: "acme.com", label: "Slop Score", score: 34, verdict })).toBe(
      "Now watching acme.com — Slop Score 34/100",
    );
  });

  it("signs the delta by the raw movement, not by the judgement", () => {
    // A 4-point AEO gain is "improved" AND "+4". Deriving the sign from
    // `improved` would print "−4" and contradict the number beside it.
    const verdict = watchVerdict({ engineKind: "aeo", previousScore: 60, nextScore: 64 });
    const subject = watchSubject({ host: "acme.com", label: "AEO Score", score: 64, verdict });
    expect(subject).toBe("acme.com improved — AEO Score 64/100 (+4 pts)");
  });

  it("signs an improving slop score negative, and still says improved", () => {
    const verdict = watchVerdict({ engineKind: "slop", previousScore: 60, nextScore: 40 });
    const subject = watchSubject({ host: "acme.com", label: "Slop Score", score: 40, verdict });
    expect(subject).toBe("acme.com improved — Slop Score 40/100 (−20 pts)");
  });
});

describe("watchScoreOf", () => {
  it("tracks summary.slopScore for a slop watch, not audits.score", () => {
    expect(
      watchScoreOf({
        target_url: "https://acme.com",
        status: "complete",
        score: 78,
        engine: "slop",
        summary: { slopScore: 34 },
      }),
    ).toBe(34);
  });

  it("tracks audits.score for an AEO watch", () => {
    expect(
      watchScoreOf({
        target_url: "https://acme.com",
        status: "complete",
        score: 78,
        engine: "rule",
        summary: {},
      }),
    ).toBe(78);
  });

  it("returns null for an unfinished scan so nothing is emailed", () => {
    expect(
      watchScoreOf({
        target_url: "https://acme.com",
        status: "running",
        score: null,
        engine: "rule",
        summary: {},
      }),
    ).toBeNull();
  });
});

describe("caps", () => {
  it("bounds watches per address", () => {
    // Unbounded watches per address is a free monitoring tier by accident.
    expect(MAX_WATCHES_PER_EMAIL).toBeGreaterThan(0);
    expect(MAX_WATCHES_PER_EMAIL).toBeLessThanOrEqual(25);
  });
});
