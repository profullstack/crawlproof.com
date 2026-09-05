import { describe, expect, it } from "vitest";
import {
  DEFAULT_WHO,
  KIND_SPLIT_CAPTION,
  WHO_OPTIONS,
  WHO_VALUES,
  headlineTiles,
  parseWho,
  pulseHeadline,
  pulseLayers,
  whoCaption,
  whoOrDefault,
  whoToKind,
} from "@/lib/tracker/who";
import { kindFromBucket } from "@/lib/tracker/humans";
import { fetchPanel, PANEL_KEYS } from "@/lib/tracker/panels";
import { trackerRange } from "@/lib/tracker/ranges";
import { buildDailyAxis } from "@/lib/tracker/series";
import { panelUrl } from "@/components/charts/use-panel-range";

// The Humans / Bots / All toggle on the project stats page is one URL value
// that has to reach every number on the page through the same mapping. These
// pin that mapping: URL -> Who -> p_kind on every RPC, and Who -> which tiles
// and which chart layers are drawn.

describe("parseWho / whoOrDefault", () => {
  it("accepts exactly the three values", () => {
    for (const v of WHO_VALUES) expect(parseWho(v)).toBe(v);
    expect(WHO_VALUES).toEqual(["humans", "bots", "all"]);
  });

  it("rejects junk strictly, so the API can 400 it", () => {
    expect(parseWho("Humans")).toBeNull();
    expect(parseWho("human")).toBeNull();
    expect(parseWho("")).toBeNull();
    expect(parseWho("bots;drop")).toBeNull();
    expect(parseWho(null)).toBeNull();
    expect(parseWho(undefined)).toBeNull();
  });

  it("defaults the page to humans", () => {
    expect(DEFAULT_WHO).toBe("humans");
    expect(whoOrDefault(undefined)).toBe("humans");
    expect(whoOrDefault("nope")).toBe("humans");
    expect(whoOrDefault("bots")).toBe("bots");
    expect(whoOrDefault("all")).toBe("all");
  });
});

describe("whoToKind", () => {
  it("maps onto the RPC argument, with All meaning no filter", () => {
    expect(whoToKind("humans")).toBe("human");
    expect(whoToKind("bots")).toBe("bot");
    expect(whoToKind("all")).toBeNull();
  });
});

describe("kindFromBucket", () => {
  it("uses the one definition: bot iff the bucket starts with bot:", () => {
    expect(kindFromBucket("bot:gptbot")).toBe("bot");
    expect(kindFromBucket("bot:other")).toBe("bot");
    // AI referrals are people arriving from an assistant.
    expect(kindFromBucket("ai_referral:chatgpt")).toBe("human");
    expect(kindFromBucket("search:google")).toBe("human");
    expect(kindFromBucket("social:x")).toBe("human");
    expect(kindFromBucket("referral:example.com")).toBe("human");
    expect(kindFromBucket("human:direct")).toBe("human");
    // Only the prefix counts; "robots" is not a bot bucket.
    expect(kindFromBucket("referral:robots.example")).toBe("human");
  });
});

describe("whoCaption", () => {
  it("says where the split starts on every filtered view, and nothing on All", () => {
    expect(whoCaption("humans")).toBe(KIND_SPLIT_CAPTION);
    expect(whoCaption("bots")).toBe(KIND_SPLIT_CAPTION);
    expect(whoCaption("all")).toBeNull();
    expect(KIND_SPLIT_CAPTION).toBe(
      "Split recorded from 5 Sep 2026; earlier traffic appears under All.",
    );
  });

  it("keeps a definition tooltip on every option", () => {
    for (const option of WHO_OPTIONS) {
      expect(option.description.length).toBeGreaterThan(20);
    }
  });
});

describe("headlineTiles", () => {
  const totals = { humans: 2570, ai: 40, bots: 254430 };

  it("shows only that side's figures under Humans and Bots", () => {
    expect(headlineTiles("humans", totals).map((t) => [t.key, t.value])).toEqual([
      ["humans", 2570],
      ["ai", 40],
    ]);
    expect(headlineTiles("bots", totals).map((t) => [t.key, t.value])).toEqual([
      ["bots", 254430],
    ]);
  });

  it("keeps the three-tile layout under All", () => {
    expect(headlineTiles("all", totals).map((t) => t.key)).toEqual([
      "humans",
      "ai",
      "bots",
    ]);
  });

  it("carries a definition on every tile", () => {
    for (const who of WHO_VALUES) {
      for (const tile of headlineTiles(who, totals)) {
        expect(tile.hint.length).toBeGreaterThan(20);
        expect(tile.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("pulseLayers / pulseHeadline", () => {
  it("draws the human band alone under Humans, the bot band alone under Bots", () => {
    expect(pulseLayers("humans").map((l) => l.dataKey)).toEqual([
      "humans",
      "ai",
      "interactions",
    ]);
    expect(pulseLayers("bots").map((l) => l.dataKey)).toEqual([
      "bots",
      "interactions",
    ]);
  });

  it("stacks humans and bots under All", () => {
    const layers = pulseLayers("all");
    expect(layers.map((l) => l.dataKey)).toEqual([
      "humans",
      "bots",
      "ai",
      "interactions",
    ]);
    expect(layers.find((l) => l.dataKey === "humans")?.stackId).toBe("1");
    expect(layers.find((l) => l.dataKey === "bots")?.stackId).toBe("1");
    // Overlays, not part of the stack, or they would inflate the total.
    expect(layers.find((l) => l.dataKey === "ai")?.stackId).toBeUndefined();
    expect(layers.find((l) => l.dataKey === "interactions")?.stackId).toBeUndefined();
  });

  it("leads the frame with bots only under Bots", () => {
    const totals = { humans: 3, bots: 997 };
    expect(pulseHeadline("humans", totals).total).toBe(3);
    expect(pulseHeadline("all", totals).total).toBe(3);
    expect(pulseHeadline("bots", totals).total).toBe(997);
    expect(pulseHeadline("bots", totals).unit).toEqual(["bot crawl", "bot crawls"]);
  });
});

describe("panelUrl", () => {
  it("sends who with every range request", () => {
    expect(panelUrl("p1", "pages", "1h", "bots")).toBe(
      "/api/projects/p1/tracker-stats?range=1h&panel=pages&who=bots",
    );
  });
});

// Records the arguments each RPC is called with.
function spySb() {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: [], error: null });
    },
  };
}

describe("fetchPanel passes p_kind to every RPC", () => {
  it("on the rollup ranges", async () => {
    for (const panel of PANEL_KEYS) {
      for (const kind of ["human", "bot", null] as const) {
        const sb = spySb();
        await fetchPanel(sb as never, "p1", panel, trackerRange("1m"), 30, kind);
        expect(sb.calls, `${panel} ${kind}`).toHaveLength(1);
        expect(sb.calls[0].args, `${panel} ${kind}`).toHaveProperty("p_kind", kind);
        expect(sb.calls[0].fn).not.toMatch(/^tracker_recent_/);
      }
    }
  });

  it("on the raw ranges too, including the rollup-only panels at 1D", async () => {
    for (const panel of PANEL_KEYS) {
      const sb = spySb();
      await fetchPanel(sb as never, "p1", panel, trackerRange("1d"), 412, "bot");
      expect(sb.calls, panel).toHaveLength(1);
      expect(sb.calls[0].args, panel).toHaveProperty("p_kind", "bot");
    }
  });

  it("defaults to no filter so older callers keep their numbers", async () => {
    const sb = spySb();
    await fetchPanel(sb as never, "p1", "pages", trackerRange("1m"), 30);
    expect(sb.calls[0].args.p_kind).toBeNull();
  });
});

describe("filtered series and the legacy events backfill", () => {
  const NOW = new Date("2026-09-05T12:00:00Z");
  // A pre-split day: the event table has rows (kind = unknown, so excluded
  // under a filter) while the bucket leg reports 0 for this side.
  const rows = [
    {
      day: "2026-09-04",
      pageviews: 50,
      interactions: 5,
      ai: 0,
      bots: 0,
      events: 0,
      humans: 0,
    },
  ];

  it("fills events from the event table only on the unfiltered series", () => {
    const all = buildDailyAxis(rows, 2, NOW);
    expect(all.find((p) => p.date === "2026-09-04")?.events).toBe(55);
  });

  it("leaves a filtered zero alone rather than borrowing the other side's rows", () => {
    const filtered = buildDailyAxis(rows, 2, NOW, { legacyEventsBackfill: false });
    expect(filtered.find((p) => p.date === "2026-09-04")?.events).toBe(0);
  });

  it("is wired that way through fetchPanel", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sb = {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, ...args });
        return Promise.resolve({
          data: fn === "tracker_daily_series" ? [{ ...rows[0], day: today() }] : [],
          error: null,
        });
      },
    };
    const human = (await fetchPanel(
      sb as never,
      "p1",
      "series",
      trackerRange("1w"),
      7,
      "human",
    )) as { points: Array<{ events: number }> };
    const all = (await fetchPanel(
      sb as never,
      "p1",
      "series",
      trackerRange("1w"),
      7,
      null,
    )) as { points: Array<{ events: number }> };
    expect(human.points.at(-1)?.events).toBe(0);
    expect(all.points.at(-1)?.events).toBe(55);
  });
});

function today() {
  return new Date().toISOString().slice(0, 10);
}
