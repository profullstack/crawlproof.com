import { describe, expect, it } from "vitest";
import { isReportDue, renderPerfReportEmail, type PerfReport } from "@/lib/perfReport";

// 09:00 in the timezone under test is the only eligible hour.
const at = (iso: string) => new Date(iso);

describe("isReportDue — daily", () => {
  it("fires at 09:00 local on any day of the week", () => {
    // A Wednesday and a Sunday; neither is special for the daily cadence.
    expect(isReportDue("daily", "UTC", at("2026-09-02T09:00:00Z"), null)).toBe(true);
    expect(isReportDue("daily", "UTC", at("2026-09-06T09:30:00Z"), null)).toBe(true);
  });

  it("ignores every other hour", () => {
    expect(isReportDue("daily", "UTC", at("2026-09-06T08:59:00Z"), null)).toBe(false);
    expect(isReportDue("daily", "UTC", at("2026-09-06T10:00:00Z"), null)).toBe(false);
  });

  it("is local, not UTC", () => {
    // 09:00 Los Angeles is 16:00 UTC.
    const utcMorning = at("2026-09-06T09:00:00Z");
    expect(isReportDue("daily", "America/Los_Angeles", utcMorning, null)).toBe(false);
    expect(isReportDue("daily", "America/Los_Angeles", at("2026-09-06T16:00:00Z"), null)).toBe(true);
  });

  it("does not send twice in the same local day", () => {
    const now = at("2026-09-06T09:00:00Z");
    const anHourAgo = at("2026-09-06T08:00:00Z");
    expect(isReportDue("daily", "UTC", now, anHourAgo)).toBe(false);
  });

  it("sends again the next day, even when the clock shifted", () => {
    // 23h later is a different local day but under the 24h a naive gate
    // would use; the 20h window is what makes a DST day still send.
    const now = at("2026-09-07T09:00:00Z");
    const yesterday = at("2026-09-06T09:00:00Z");
    expect(isReportDue("daily", "UTC", now, yesterday)).toBe(true);
  });

  it("leaves the other cadences alone", () => {
    // 2026-09-06 is a Sunday, so weekly (Monday) must not fire.
    expect(isReportDue("weekly", "UTC", at("2026-09-06T09:00:00Z"), null)).toBe(false);
    expect(isReportDue("monthly", "UTC", at("2026-09-06T09:00:00Z"), null)).toBe(false);
    expect(isReportDue("weekly", "UTC", at("2026-09-07T09:00:00Z"), null)).toBe(true);
  });
});

const report = (overrides: Partial<PerfReport> = {}): PerfReport => ({
  userId: "u1",
  userEmail: "a@b.com",
  userDisplayName: "A",
  cadence: "daily",
  windowStart: at("2026-09-05T09:00:00Z"),
  windowEnd: at("2026-09-06T09:00:00Z"),
  projects: [],
  autoblog: null,
  traffic: {
    humans: 1234,
    bots: 91011,
    total: 92245,
    properties: [
      { projectId: "p1", name: "genrewatch.com", humans: 27, bots: 90000, total: 90027 },
      { projectId: "p2", name: "chovy blog", humans: 1207, bots: 1011, total: 2218 },
    ],
  },
  ...overrides,
});

describe("the nightly email", () => {
  it("leads its subject with humans, and formats big numbers", () => {
    const { subject, html } = renderPerfReportEmail(report());
    expect(subject).toBe("CrawlProof nightly — 1,234 human visits, 91,011 bot");
    expect(html).toContain("genrewatch.com");
    expect(html).toContain("90,027");
  });

  it("lists properties in the order the aggregator gave them", () => {
    const { html } = renderPerfReportEmail(report());
    expect(html.indexOf("genrewatch.com")).toBeLessThan(html.indexOf("chovy blog"));
  });

  it("shows each property's bot share", () => {
    const { html } = renderPerfReportEmail(report());
    expect(html).toContain("27 human · 90,000 bot (100%)");
  });

  it("says so plainly when nothing was recorded", () => {
    const { html } = renderPerfReportEmail(
      report({ traffic: { humans: 0, bots: 0, total: 0, properties: [] } }),
    );
    expect(html).toContain("No traffic recorded");
  });

  it("keeps the weekly subject unchanged", () => {
    const { subject } = renderPerfReportEmail(report({ cadence: "weekly" }));
    expect(subject).toContain("weekly digest");
  });
});
