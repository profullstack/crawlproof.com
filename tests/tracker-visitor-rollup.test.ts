import { describe, expect, it } from "vitest";
import {
  SCRIPTED_BUCKET,
  SCRIPTED_CAP_EVENTS,
  SCRIPTED_CAP_PAGEVIEWS,
  applyScriptedDemotion,
  parseVisitorTouch,
} from "@/lib/tracker/scripted";
import {
  HUMANS_LABEL,
  PAGEVIEWS_LABEL,
  VISITORS_LABEL,
  kindFromBucket,
} from "@/lib/tracker/humans";
import { headlineTiles, pulseHeadline } from "@/lib/tracker/who";
import {
  VISITORS_SINCE,
  sumVisitorTotals,
  toVisitorTotals,
  visitorsPartial,
} from "@/lib/tracker/visitors";
import { mergeTotals, totalsFromSeries } from "@/lib/tracker/apiStats";
import { renderStats } from "@/lib/dashboard/stats-text";

// The tracker used to lead with "Human visits", which was every beacon from a
// non-crawler user agent: the page view plus four scroll depths, every click
// and every form submit. On four properties that read 51,531 in a week
// while the raw table held 420 distinct visitor ids in a day — the number an
// independent analytics tool also reported. These pin the pieces that keep
// people and events apart: the scripted cap, the tile order, the API totals
// and the CLI line.

describe("applyScriptedDemotion", () => {
  it("leaves a user-agent bot alone, whatever the rollup says", () => {
    const out = applyScriptedDemotion("bot:gptbot", { kind: "bot", events: 1, pageviews: 1 });
    expect(out).toEqual({ bucket: "bot:gptbot", kind: "bot", demoted: false });
  });

  it("keeps a human hit human while the rollup still calls the visitor human", () => {
    const out = applyScriptedDemotion("search:google", { kind: "human", events: 40, pageviews: 12 });
    expect(out).toEqual({ bucket: "search:google", kind: "human", demoted: false });
  });

  it("demotes a human hit once the rollup has flipped the visitor to bot", () => {
    const out = applyScriptedDemotion("referral:bittorrented.com", {
      kind: "bot",
      events: SCRIPTED_CAP_EVENTS + 1,
      pageviews: 4,
    });
    expect(out).toEqual({ bucket: SCRIPTED_BUCKET, kind: "bot", demoted: true });
    expect(kindFromBucket(out.bucket)).toBe("bot");
  });

  it("fails open: no visitor id or a failed RPC leaves the verdict standing", () => {
    expect(applyScriptedDemotion("human:direct", null)).toEqual({
      bucket: "human:direct",
      kind: "human",
      demoted: false,
    });
  });

  it("caps are per visitor per day and generous enough for a binge reader", () => {
    expect(SCRIPTED_CAP_PAGEVIEWS).toBeGreaterThanOrEqual(150);
    expect(SCRIPTED_CAP_EVENTS).toBeGreaterThan(SCRIPTED_CAP_PAGEVIEWS);
  });
});

describe("parseVisitorTouch", () => {
  it("reads the one row the RPC returns, as an array or bare, with bigint strings", () => {
    expect(parseVisitorTouch([{ kind: "human", events: "3", pageviews: "1" }])).toEqual({
      kind: "human",
      events: 3,
      pageviews: 1,
    });
    expect(parseVisitorTouch({ kind: "bot", events: 501, pageviews: 4 })).toEqual({
      kind: "bot",
      events: 501,
      pageviews: 4,
    });
  });

  it("is null for anything that is not a kind", () => {
    expect(parseVisitorTouch(null)).toBeNull();
    expect(parseVisitorTouch([])).toBeNull();
    expect(parseVisitorTouch({ kind: "unknown", events: 1 })).toBeNull();
    expect(parseVisitorTouch("bot")).toBeNull();
  });
});

describe("headlineTiles with the visitor rollup", () => {
  const totals = { visitors: 420, pageviews: 1585, humans: 5796, ai: 12, bots: 90 };

  it("leads with people, then their page views, then events under their real name", () => {
    const tiles = headlineTiles("humans", totals);
    expect(tiles.map((t) => [t.key, t.value])).toEqual([
      ["visitors", 420],
      ["pageviews", 1585],
      ["humans", 5796],
      ["ai", 12],
    ]);
    expect(tiles[0].label).toBe(VISITORS_LABEL);
    expect(tiles[1].label).toBe(PAGEVIEWS_LABEL);
    expect(tiles[2].label).toBe(HUMANS_LABEL);
    expect(HUMANS_LABEL).not.toMatch(/visit/i);
    // The event count is no longer the accent figure.
    expect(tiles[0].tone).toBe("accent");
    expect(tiles[2].tone).toBe("muted");
  });

  it("shows the bot side's own visitors under Bots", () => {
    const tiles = headlineTiles("bots", { ...totals, visitors: 7, pageviews: 30 });
    expect(tiles.map((t) => t.key)).toEqual(["visitors", "pageviews", "bots"]);
    expect(tiles[0].label).toBe("Bot visitors");
  });

  it("keeps both sides under All", () => {
    expect(headlineTiles("all", totals).map((t) => t.key)).toEqual([
      "visitors",
      "pageviews",
      "humans",
      "ai",
      "bots",
    ]);
  });

  it("leaves the people tiles out — never 0 — when the rollup is unavailable", () => {
    const tiles = headlineTiles("humans", { ...totals, visitors: null, pageviews: null });
    expect(tiles.map((t) => t.key)).toEqual(["humans", "ai"]);
    expect(tiles[0].tone).toBe("accent");
    // And the pre-rollup call shape is unchanged.
    expect(headlineTiles("humans", { humans: 3, ai: 1, bots: 9 }).map((t) => t.key)).toEqual([
      "humans",
      "ai",
    ]);
  });

  it("names the pulse figure as events, not visits", () => {
    expect(pulseHeadline("humans", { humans: 3, bots: 9 }).unit).toEqual([
      "human event",
      "human events",
    ]);
  });
});

describe("visitor totals", () => {
  it("coerces PostgREST strings and sums across projects", () => {
    const a = toVisitorTotals({ project_id: "a", visitors: "372", prev_visitors: "0", pageviews: "1469", prev_pageviews: "0" });
    const b = toVisitorTotals({ project_id: "b", visitors: 30, prev_visitors: 4, pageviews: 73, prev_pageviews: 9 });
    expect(sumVisitorTotals([a, b])).toEqual({
      visitors: 402,
      prevVisitors: 4,
      pageviews: 1542,
      prevPageviews: 9,
    });
  });

  it("knows when a window reaches back before the rollup existed", () => {
    const since = new Date(`${VISITORS_SINCE}T12:00:00Z`);
    expect(visitorsPartial(1, since)).toBe(false);
    expect(visitorsPartial(2, since)).toBe(true);
    const later = new Date(since.getTime() + 30 * 86_400_000);
    expect(visitorsPartial(30, later)).toBe(false);
    expect(visitorsPartial(31, later)).toBe(false);
    expect(visitorsPartial(32, later)).toBe(true);
  });
});

describe("API totals", () => {
  it("never reports events as visitors", () => {
    const fromSeries = totalsFromSeries({
      points: [
        { humans: 2130, pageviews: 700 },
        { humans: 3666, pageviews: 885 },
      ],
    } as never);
    expect(fromSeries).toEqual({ events: 5796, pageviews: 1585 });
    expect("visitors" in fromSeries).toBe(false);
  });

  it("takes people from the rollup and events from the series", () => {
    expect(mergeTotals({ events: 5796, pageviews: 1585 }, { visitors: 420, pageviews: 1469 })).toEqual({
      visitors: 420,
      pageviews: 1469,
      events: 5796,
    });
  });

  it("reports an unreadable rollup as null, not 0", () => {
    expect(mergeTotals({ events: 5796, pageviews: 1585 }, null)).toEqual({
      visitors: null,
      pageviews: null,
      events: 5796,
    });
  });
});

describe("CLI stats line", () => {
  it("prints people, page views and events, in that order", () => {
    const text = renderStats(
      { project: { name: "bittorrented.com" }, totals: { visitors: 420, pageviews: 1469, events: 5796 } },
      { range: "1d", who: "humans" },
    );
    expect(text).toContain("420 visitors, 1469 pageviews, 5796 events");
  });

  it("says visitors are unavailable rather than printing 0", () => {
    const text = renderStats(
      { project: { name: "x" }, totals: { visitors: null, pageviews: null, events: 12 } },
      { range: "1d", who: "humans" },
    );
    expect(text).toContain("visitors unavailable, 12 events");
    expect(text).not.toContain("Nothing in this window");
  });
});
