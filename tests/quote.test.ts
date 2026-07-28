import { describe, it, expect } from "vitest";
import {
  HOURLY_RATE_USD,
  TARGET_SCORE,
  formatHours,
  formatUsd,
  quoteFromCounts,
  quoteFromFindings,
} from "@/lib/audit/quote";
import type { Finding } from "@/lib/audit/types";

function f(check_key: string, status: Finding["status"] = "fail"): Finding {
  return { section: "S", check_key, status, title: check_key, priority: 3 };
}

describe("quote: pricing basics", () => {
  it("bills at $100/hour and promises 90%+", () => {
    expect(HOURLY_RATE_USD).toBe(100);
    expect(TARGET_SCORE).toBe(90);
    const q = quoteFromFindings([f("homepage.title")]);
    expect(q.rateUsd).toBe(100);
    expect(q.targetScore).toBe(90);
    expect(q.amountUsd).toBe(Math.round((q.totalHours * 100) / 100) * 100);
  });

  it("always splits hours into AI-assisted and manual", () => {
    const q = quoteFromFindings([f("homepage.title"), f("dns.spf")]);
    expect(q.aiHours).toBeGreaterThan(0);
    expect(q.manualHours).toBeGreaterThan(0);
    expect(q.totalHours).toBeCloseTo(q.aiHours + q.manualHours, 5);
  });

  it("quotes baseline overhead even for a nearly clean site", () => {
    const clean = quoteFromFindings([f("homepage.title", "warn")]);
    // Intake + plan + verification re-scan still has to be paid for.
    expect(clean.totalHours).toBeGreaterThanOrEqual(4);
    expect(clean.amountUsd).toBeGreaterThanOrEqual(400);
  });

  it("ignores passes — a passing check is not work", () => {
    const withPasses = quoteFromFindings([
      f("homepage.title"),
      f("schema.org", "pass"),
      f("meta.viewport", "pass"),
    ]);
    const withoutPasses = quoteFromFindings([f("homepage.title")]);
    expect(withPasses.amountUsd).toBe(withoutPasses.amountUsd);
    expect(withPasses.issueCount).toBe(1);
  });

  it("does not bill twice for recommendation and to-do restatements", () => {
    const real = quoteFromFindings([f("homepage.title"), f("homepage.description")]);
    const padded = quoteFromFindings([
      f("homepage.title"),
      f("homepage.description"),
      f("rec.homepage.title", "warn"),
      f("todo.homepage.title", "warn"),
      f("slop.score"),
      f("slop.coverage", "warn"),
      f("crawl.pages_fetched"),
    ]);
    expect(padded.amountUsd).toBe(real.amountUsd);
  });

  it("bills one fix once, however many engines flagged it", () => {
    const oneEngine = quoteFromFindings([f("homepage.description"), f("schema.org")]);
    // Same two defects, reported by four engines in a consolidated scan run.
    const fourEngines = quoteFromFindings([
      ...Array.from({ length: 4 }, () => f("homepage.description")),
      ...Array.from({ length: 4 }, () => f("schema.org")),
    ]);
    expect(fourEngines.amountUsd).toBe(oneEngine.amountUsd);
    expect(fourEngines.issueCount).toBe(2);
  });

  it("keeps the worst status when engines disagree", () => {
    const asWarn = quoteFromFindings([f("homepage.title", "warn")]);
    const mixed = quoteFromFindings([f("homepage.title", "warn"), f("homepage.title", "fail")]);
    expect(mixed.totalHours).toBeGreaterThan(asWarn.totalHours);
    expect(mixed.issueCount).toBe(1);
  });

  it("charges a warn less than a fail", () => {
    const fail = quoteFromFindings([f("homepage.title", "fail")]);
    const warn = quoteFromFindings([f("homepage.title", "warn")]);
    expect(warn.totalHours).toBeLessThan(fail.totalHours);
  });

  it("scales with the number of issues", () => {
    const few = quoteFromFindings([f("meta.a"), f("meta.b")]);
    const many = quoteFromFindings(
      Array.from({ length: 40 }, (_, i) => f(`meta.x${i}`)),
    );
    expect(many.amountUsd).toBeGreaterThan(few.amountUsd * 2);
  });
});

describe("quote: AI vs manual classification", () => {
  it("treats markup/metadata as mostly AI work", () => {
    const q = quoteFromFindings(Array.from({ length: 10 }, (_, i) => f(`meta.tag${i}`)));
    expect(q.aiHours).toBeGreaterThan(q.manualHours);
  });

  it("treats DNS and crawler-access records as mostly manual", () => {
    const base = quoteFromFindings([]);
    const q = quoteFromFindings(Array.from({ length: 10 }, (_, i) => f(`dns.record${i}`)));
    // Net of the fixed baseline, DNS work is manual-dominant.
    expect(q.manualHours - base.manualHours).toBeGreaterThan(q.aiHours - base.aiHours);
  });

  it("treats original content and positioning as mostly manual", () => {
    const base = quoteFromFindings([]);
    const q = quoteFromFindings([
      f("content.no_first_party_evidence"),
      f("content.thin"),
      f("positioning.what"),
      f("slop.site.content.near_duplicate"),
    ]);
    expect(q.manualHours - base.manualHours).toBeGreaterThan(q.aiHours - base.aiHours);
  });

  it("prices a template fix above a single page but below the pages it resolves", () => {
    const systemic = quoteFromFindings([f("slop.systemic.design.no_viewport")]);
    const onePage = quoteFromFindings([f("slop.page.about")]);
    const tenPages = quoteFromFindings(
      Array.from({ length: 10 }, (_, i) => f(`slop.page.p${i}`)),
    );
    expect(systemic.totalHours).toBeGreaterThan(onePage.totalHours);
    expect(systemic.totalHours).toBeLessThan(tenPages.totalHours);
  });

  it("reports drivers, largest first, summing to the quoted hours", () => {
    const q = quoteFromFindings([
      f("content.no_first_party_evidence"),
      f("content.thin"),
      f("meta.title"),
      f("dns.spf"),
    ]);
    expect(q.drivers.length).toBeGreaterThan(1);
    const totals = q.drivers.map((d) => d.aiHours + d.manualHours);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(q.drivers.some((d) => d.label === "Original content & positioning")).toBe(true);
    expect(q.drivers.some((d) => d.label === "DNS, robots & crawler access")).toBe(true);
  });
});

describe("quote: guardrails", () => {
  it("caps a catastrophic report and flags it for manual scoping", () => {
    const q = quoteFromFindings(
      Array.from({ length: 600 }, (_, i) => f(`content.no_first_party_evidence${i}`)),
    );
    expect(q.cappedForScoping).toBe(true);
    expect(q.totalHours).toBeLessThanOrEqual(120);
    expect(q.amountUsd).toBeLessThanOrEqual(12_000);
  });

  it("does not flag a normal report for scoping", () => {
    const q = quoteFromFindings(Array.from({ length: 25 }, (_, i) => f(`meta.x${i}`)));
    expect(q.cappedForScoping).toBe(false);
  });

  it("rounds to half hours and whole hundreds of dollars", () => {
    const q = quoteFromFindings(Array.from({ length: 7 }, (_, i) => f(`meta.x${i}`, "warn")));
    expect(q.aiHours * 2).toBe(Math.round(q.aiHours * 2));
    expect(q.manualHours * 2).toBe(Math.round(q.manualHours * 2));
    expect(q.amountUsd % 100).toBe(0);
  });

  it("falls back to summary counts when findings are unavailable", () => {
    const q = quoteFromCounts({ warn: 10, fail: 5 });
    expect(q.issueCount).toBe(15);
    expect(q.amountUsd).toBeGreaterThan(0);
    expect(q.aiHours).toBeGreaterThan(0);
    expect(q.manualHours).toBeGreaterThan(0);
  });

  it("handles an empty report without dividing by zero", () => {
    const q = quoteFromFindings([]);
    expect(q.issueCount).toBe(0);
    expect(Number.isFinite(q.amountUsd)).toBe(true);
    expect(q.amountUsd).toBeGreaterThan(0); // baseline only
  });
});

describe("quote: formatting", () => {
  it("formats money with thousands separators", () => {
    expect(formatUsd(4000)).toBe("$4,000");
    expect(formatUsd(700)).toBe("$700");
  });

  it("drops the decimal on whole hours", () => {
    expect(formatHours(40)).toBe("40h");
    expect(formatHours(12.5)).toBe("12.5h");
  });
});
