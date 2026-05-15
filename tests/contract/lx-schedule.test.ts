import { describe, it, expect } from "vitest";
import { nextPublishAt } from "@/lib/lx/schedule";

describe("nextPublishAt", () => {
  it("returns null when no days are allowed", () => {
    expect(nextPublishAt([], 9, new Date("2026-05-13T08:00:00Z"))).toBeNull();
  });

  it("picks today when the hour hasn't passed yet", () => {
    // 2026-05-13 is a Wed (ISO 3). Hour 09:00 hasn't fired yet at 08:00.
    const r = nextPublishAt([1, 2, 3, 4, 5], 9, new Date("2026-05-13T08:00:00Z"));
    expect(r?.toISOString()).toBe("2026-05-13T09:00:00.000Z");
  });

  it("skips to the next allowed day when today's hour has passed", () => {
    // 09:00 already gone; next weekday is Thu 2026-05-14.
    const r = nextPublishAt([1, 2, 3, 4, 5], 9, new Date("2026-05-13T10:00:00Z"));
    expect(r?.toISOString()).toBe("2026-05-14T09:00:00.000Z");
  });

  it("jumps over weekends", () => {
    // Fri 2026-05-15 after 09:00 → next is Mon 2026-05-18.
    const r = nextPublishAt([1, 2, 3, 4, 5], 9, new Date("2026-05-15T10:00:00Z"));
    expect(r?.toISOString()).toBe("2026-05-18T09:00:00.000Z");
  });

  it("honors a Sunday-only schedule", () => {
    // From Wed 2026-05-13 the next Sun is 2026-05-17 (ISO weekday 7).
    const r = nextPublishAt([7], 12, new Date("2026-05-13T08:00:00Z"));
    expect(r?.toISOString()).toBe("2026-05-17T12:00:00.000Z");
  });

  it("respects publish_hour at boundary (does not pick the exact same minute)", () => {
    // At exactly 09:00, the candidate hour matches now — must skip to next slot.
    const r = nextPublishAt([1, 2, 3, 4, 5], 9, new Date("2026-05-13T09:00:00Z"));
    expect(r?.toISOString()).toBe("2026-05-14T09:00:00.000Z");
  });
});
