import { describe, it, expect } from "vitest";
import { isReportDue, partsInTimezone } from "@/lib/perfReport";
import { isValidTimezone } from "@/lib/timezones";

describe("partsInTimezone", () => {
  it("projects a UTC instant into a Western-hemisphere TZ", () => {
    // 2026-05-18 (Mon) 16:00 UTC = 09:00 America/Los_Angeles (PDT, -07).
    const utc = new Date("2026-05-18T16:00:00.000Z");
    const parts = partsInTimezone(utc, "America/Los_Angeles");
    expect(parts.hour).toBe(9);
    expect(parts.weekday).toBe(1); // Mon
    expect(parts.day).toBe(18);
  });

  it("rolls over the day for Asia/Tokyo", () => {
    // 2026-05-17 (Sun) 23:00 UTC = 2026-05-18 (Mon) 08:00 Asia/Tokyo (+09).
    const utc = new Date("2026-05-17T23:00:00.000Z");
    const parts = partsInTimezone(utc, "Asia/Tokyo");
    expect(parts.weekday).toBe(1); // Mon in Tokyo
    expect(parts.day).toBe(18);
    expect(parts.hour).toBe(8);
  });

  it("UTC is the identity", () => {
    const utc = new Date("2026-05-15T09:00:00.000Z");
    expect(partsInTimezone(utc, "UTC")).toEqual({
      weekday: 5, // Fri
      day: 15,
      hour: 9,
    });
  });
});

describe("isReportDue — weekly", () => {
  const tz = "America/New_York";
  // 2026-05-18 13:00 UTC = 2026-05-18 (Mon) 09:00 America/New_York (EDT).
  const monAt9 = new Date("2026-05-18T13:00:00.000Z");

  it("fires on Monday 09:00 local with no prior send", () => {
    expect(isReportDue("weekly", tz, monAt9, null)).toBe(true);
  });

  it("does NOT fire at 08:00 local", () => {
    const monAt8 = new Date("2026-05-18T12:00:00.000Z");
    expect(isReportDue("weekly", tz, monAt8, null)).toBe(false);
  });

  it("does NOT fire on a Tuesday", () => {
    const tueAt9 = new Date("2026-05-19T13:00:00.000Z");
    expect(isReportDue("weekly", tz, tueAt9, null)).toBe(false);
  });

  it("dedupes if sent within the last 6 days", () => {
    const lastSent = new Date("2026-05-13T13:00:00.000Z"); // 5 days earlier
    expect(isReportDue("weekly", tz, monAt9, lastSent)).toBe(false);
  });

  it("re-fires after 7 days", () => {
    const lastSent = new Date("2026-05-11T13:00:00.000Z"); // 7 days earlier
    expect(isReportDue("weekly", tz, monAt9, lastSent)).toBe(true);
  });
});

describe("isReportDue — monthly", () => {
  const tz = "Europe/London";
  // 2026-06-01 08:00 UTC = 2026-06-01 (Mon) 09:00 Europe/London (BST).
  const firstAt9 = new Date("2026-06-01T08:00:00.000Z");

  it("fires on the 1st at 09:00 local", () => {
    expect(isReportDue("monthly", tz, firstAt9, null)).toBe(true);
  });

  it("does NOT fire on the 2nd", () => {
    const secondAt9 = new Date("2026-06-02T08:00:00.000Z");
    expect(isReportDue("monthly", tz, secondAt9, null)).toBe(false);
  });

  it("does NOT fire at 10:00 local", () => {
    const firstAt10 = new Date("2026-06-01T09:00:00.000Z");
    expect(isReportDue("monthly", tz, firstAt10, null)).toBe(false);
  });

  it("dedupes within the last 27 days", () => {
    const lastSent = new Date("2026-05-10T08:00:00.000Z");
    expect(isReportDue("monthly", tz, firstAt9, lastSent)).toBe(false);
  });
});

describe("isReportDue — bad timezone falls back to UTC", () => {
  // 2026-05-18 09:00 UTC, Monday — eligible under UTC.
  const monAt9 = new Date("2026-05-18T09:00:00.000Z");
  it("doesn't throw on garbage", () => {
    expect(isReportDue("weekly", "Not/A_Real_Zone", monAt9, null)).toBe(true);
  });
});

describe("isValidTimezone", () => {
  it("accepts common IANA zones", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Not/A_Zone")).toBe(false);
  });
});
