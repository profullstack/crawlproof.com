import { describe, expect, it } from "vitest";
import { fetchPanel, rollupDays } from "@/lib/tracker/panels";
import {
  PANEL_RANGE_KEYS,
  ROLLUP_ONLY_RANGES,
  rangesForPanel,
  trackerRange,
} from "@/lib/tracker/ranges";

// The "1D" tab is a raw-event range (minutes, no days) for most panels, but the
// four rollup-only panels accept it too. Before this was pinned, those panels
// resolved it to the project's whole history, so 1D and All returned the same
// number and nobody could tell a spike from a total.

// Records the arguments each RPC is called with; every rollup RPC here returns
// an empty list, which is enough since we assert on the call, not the payload.
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

describe("rollupDays", () => {
  it("collapses a sub-day range to a single rollup day", () => {
    expect(rollupDays(trackerRange("1d"), 999)).toBe(1);
    expect(rollupDays(trackerRange("1h"), 999)).toBe(1);
  });

  it("passes rollup ranges through untouched", () => {
    expect(rollupDays(trackerRange("1w"), 7)).toBe(7);
    expect(rollupDays(trackerRange("1m"), 30)).toBe(30);
    // "All" resolves upstream in resolveDays; whatever it computed survives.
    expect(rollupDays(trackerRange("all"), 412)).toBe(412);
  });
});

describe("rollup-only panels at the 1D tab", () => {
  const rollupOnly = Object.keys(PANEL_RANGE_KEYS);

  it("offers 1D on every rollup-only panel", () => {
    expect(rollupOnly.length).toBeGreaterThan(0);
    for (const panel of rollupOnly) {
      expect(PANEL_RANGE_KEYS[panel]).toContain("1d");
    }
    expect(ROLLUP_ONLY_RANGES).toContain("1d");
  });

  it("asks for one day, not the resolved history span", async () => {
    for (const panel of rollupOnly) {
      const sb = spySb();
      // 412 is what resolveDays hands back for a raw range today: the whole
      // project history. The panel must not use it.
      await fetchPanel(sb as never, "p1", panel as never, trackerRange("1d"), 412);
      expect(sb.calls).toHaveLength(1);
      expect(sb.calls[0].args.days, `${panel} at 1D`).toBe(1);
    }
  });

  it("still honours a real rollup range", async () => {
    for (const panel of rollupOnly) {
      const sb = spySb();
      await fetchPanel(sb as never, "p1", panel as never, trackerRange("1m"), 30);
      expect(sb.calls[0].args.days, `${panel} at 1M`).toBe(30);
    }
  });

  it("labels the 1D tab as the UTC day it actually reads", () => {
    for (const panel of rollupOnly) {
      const ranges = rangesForPanel(panel);
      expect(ranges).toHaveLength(ROLLUP_ONLY_RANGES.length);
      expect(
        ranges.find((r) => r.key === "1d")?.description,
        `${panel} 1D tooltip`,
      ).toBe("Today so far, UTC day");
    }
  });

  it("leaves the raw-capable panels alone", async () => {
    expect(rangesForPanel("pages")).toHaveLength(7);
    expect(rangesForPanel("pages").find((r) => r.key === "1d")?.description).toBe(
      "Last 24 hours, hourly buckets",
    );
    // The top-pages panel keeps its rolling 24h source at 1D — that is why it
    // reads ~4k for /login while exit pages reads today's rollup.
    const sb = spySb();
    await fetchPanel(sb as never, "p1", "pages" as never, trackerRange("1d"), 412);
    expect(sb.calls[0].fn).toBe("tracker_recent_top_pages");
    expect(sb.calls[0].args.p_minutes).toBe(1440);
  });
});
