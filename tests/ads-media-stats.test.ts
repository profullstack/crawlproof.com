import { describe, expect, it } from "vitest";
import {
  attributedClicks,
  ctrReadable,
  ctrUnreadableNote,
  mediaSplitRows,
  rotatedImpressions,
  MIN_CLICKS_TO_COMPARE,
  UNATTRIBUTED,
} from "@/lib/ads/media-stats";

/** An RPC row, with the zeros the RPC would actually send. */
function row(
  media: string | null,
  over: Partial<{
    impressions: number;
    free_impressions: number;
    clicks: number;
    free_clicks: number;
    spent_cents: number;
  }> = {},
) {
  return {
    media,
    impressions: 0,
    free_impressions: 0,
    clicks: 0,
    free_clicks: 0,
    spent_cents: 0,
    ...over,
  };
}

describe("shaping the split", () => {
  it("counts paid and free together, because a mix describes what was shown", () => {
    // Every fill on this network books free, so a paid-only impressions figure
    // would report the whole card as zeros — the #199 bug, one surface later.
    const [r] = mediaSplitRows([row("gif", { impressions: 4, free_impressions: 96 })]);
    expect(r.impressions).toBe(100);
    expect(r.paidImpressions).toBe(4);
    expect(r.freeImpressions).toBe(96);
  });

  it("denominates share on rotated delivery, not on everything in the window", () => {
    // The pre-rotation archive is much larger than anything the rotation has
    // served. Including it would make all five arms read ~0% forever.
    const rows = mediaSplitRows([
      row("static", { free_impressions: 60 }),
      row("gif", { free_impressions: 40 }),
      row(UNATTRIBUTED, { free_impressions: 100_000 }),
    ]);
    const byMedia = Object.fromEntries(rows.map((r) => [r.media, r]));
    expect(byMedia.static.share).toBeCloseTo(0.6);
    expect(byMedia.gif.share).toBeCloseTo(0.4);
    // Context, not a competitor.
    expect(byMedia[UNATTRIBUTED].share).toBe(0);
    expect(byMedia[UNATTRIBUTED].rotated).toBe(false);
  });

  it("has the five arms' shares sum to 1", () => {
    const rows = mediaSplitRows([
      row("static", { free_impressions: 7 }),
      row("image", { free_impressions: 5 }),
      row("gif", { free_impressions: 3 }),
      row("video", { free_impressions: 2 }),
      row("audio", { free_impressions: 1 }),
      row(UNATTRIBUTED, { free_impressions: 900 }),
    ]);
    const total = rows.filter((r) => r.rotated).reduce((a, r) => a + r.share, 0);
    expect(total).toBeCloseTo(1);
  });

  it("treats a null medium as unattributed rather than as static", () => {
    // Folding the archive into 'static' would make static the permanent winner
    // of an experiment it never ran in.
    const [r] = mediaSplitRows([row(null, { free_impressions: 10 })]);
    expect(r.media).toBe(UNATTRIBUTED);
    expect(r.rotated).toBe(false);
  });

  it("reports no CTR at all where there were no impressions to divide by", () => {
    // null, not 0: "nobody clicked this" and "nothing was measured" are
    // different findings, and only one of them is about the medium.
    const [r] = mediaSplitRows([row("video")]);
    expect(r.ctr).toBeNull();
  });

  it("computes CTR over delivered impressions and delivered clicks", () => {
    const [r] = mediaSplitRows([
      row("gif", { free_impressions: 200, clicks: 1, free_clicks: 3 }),
    ]);
    expect(r.ctr).toBeCloseTo(4 / 200);
  });

  it("orders arms by delivery and keeps the unattributed bucket last", () => {
    const rows = mediaSplitRows([
      row(UNATTRIBUTED, { free_impressions: 10_000 }),
      row("gif", { free_impressions: 5 }),
      row("static", { free_impressions: 50 }),
    ]);
    expect(rows.map((r) => r.media)).toEqual(["static", "gif", UNATTRIBUTED]);
  });

  it("tolerates the strings PostgREST sends for bigint", () => {
    const [r] = mediaSplitRows([
      { media: "gif", impressions: "5", free_impressions: "7", clicks: "2", free_clicks: "0", spent_cents: "13" },
    ]);
    expect(r.impressions).toBe(12);
    expect(r.clicks).toBe(2);
    expect(r.spentCents).toBe(13);
  });
});

describe("whether the rate can be read", () => {
  const delivered = (n: number) => mediaSplitRows([row("gif", { free_impressions: n })]);

  it("withholds CTR when nothing has been clicked", () => {
    const rows = delivered(5000);
    expect(ctrReadable(rows)).toBe(false);
    const note = ctrUnreadableNote(rows);
    // The note has to name the structural cause. "Not enough data yet" would
    // tell the reader to wait, and waiting will not fix a network whose every
    // campaign and slot share one account.
    expect(note).toMatch(/no clicks yet/);
    expect(note).toMatch(/self-deal/);
    expect(note).toMatch(/Playback/);
  });

  it("withholds CTR on a click count too small to mean anything", () => {
    const rows = mediaSplitRows([
      row("gif", { free_impressions: 5000, free_clicks: MIN_CLICKS_TO_COMPARE - 1 }),
    ]);
    expect(ctrReadable(rows)).toBe(false);
    expect(ctrUnreadableNote(rows)).toMatch(/noise/);
  });

  it("shows CTR once there are enough clicks to compare", () => {
    const rows = mediaSplitRows([
      row("gif", { free_impressions: 5000, free_clicks: MIN_CLICKS_TO_COMPARE }),
    ]);
    expect(ctrReadable(rows)).toBe(true);
    expect(ctrUnreadableNote(rows)).toBeUndefined();
  });

  it("says the mix is simply absent when nothing has rotated", () => {
    const rows = mediaSplitRows([row(UNATTRIBUTED, { free_impressions: 900 })]);
    expect(rotatedImpressions(rows)).toBe(0);
    expect(ctrUnreadableNote(rows)).toMatch(/No rotated delivery/);
  });

  it("counts only attributed clicks toward readability", () => {
    // A pile of clicks that cannot be tied to a medium must not unlock a
    // per-medium rate.
    const rows = mediaSplitRows([
      row("gif", { free_impressions: 100 }),
      row(UNATTRIBUTED, { free_clicks: 10_000 }),
    ]);
    expect(attributedClicks(rows)).toBe(0);
    expect(ctrReadable(rows)).toBe(false);
  });
});
