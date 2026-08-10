import { beforeEach, describe, expect, it, vi } from "vitest";

// Impressions had no dedupe at all while clicks had a 6h window. A scheduled
// pool refresher fetching one slot 12 times in ~3 seconds therefore booked 12
// advertiser impressions per run, every 10 minutes, with no human involved.

const H = vi.hoisted(() => ({
  state: {
    // Rows the dedupe probe will "find" for the slot inside the window.
    existing: [] as Array<{ id: string }>,
    lastQuery: null as null | Record<string, unknown>,
    throwOnSelect: false,
  },
}));
const { state } = H;

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from(table: string) {
      if (table !== "ad_impressions") throw new Error(`unexpected table ${table}`);
      if (state.throwOnSelect) {
        // Mirrors a client whose shape doesn't match — the probe must swallow it.
        return {} as never;
      }
      const q: Record<string, unknown> = {};
      const rec = (k: string) => (v: unknown) => {
        (state.lastQuery ??= {})[k] = v;
        return q;
      };
      q.select = rec("select");
      q.eq = (col: string, v: unknown) => {
        (state.lastQuery ??= {})[col] = v;
        return q;
      };
      q.gte = (col: string, v: unknown) => {
        (state.lastQuery ??= {})[`gte_${col}`] = v;
        return q;
      };
      q.limit = rec("limit");
      q.or = (terms: string) => {
        (state.lastQuery ??= {}).or = terms;
        return Promise.resolve({ data: state.existing, error: null });
      };
      return q;
    },
  }),
}));

import { isDuplicateImpression, IMPRESSION_DEDUPE_WINDOW_MS } from "@/lib/ads/fraud";

beforeEach(() => {
  state.existing = [];
  state.lastQuery = null;
  state.throwOnSelect = false;
});

describe("isDuplicateImpression", () => {
  it("flags a repeat view of the same slot inside the window", async () => {
    state.existing = [{ id: "imp-earlier" }];
    const dup = await isDuplicateImpression({
      slotId: "slot-1",
      visitorId: "v-abc",
      ipHashes: ["a".repeat(32)],
    });
    expect(dup).toBe(true);
  });

  it("does not flag the first view", async () => {
    state.existing = [];
    const dup = await isDuplicateImpression({
      slotId: "slot-1",
      visitorId: "v-abc",
      ipHashes: ["a".repeat(32)],
    });
    expect(dup).toBe(false);
  });

  it("keys on the slot, not the campaign", async () => {
    // The burst draws a different campaign per fetch, so campaign-keyed dedupe
    // would collapse none of it. The probe must never constrain campaign_id.
    state.existing = [{ id: "imp-earlier" }];
    await isDuplicateImpression({ slotId: "slot-1", ipHashes: ["b".repeat(32)] });
    expect(state.lastQuery).toBeTruthy();
    expect(state.lastQuery).toHaveProperty("slot_id", "slot-1");
    expect(state.lastQuery).not.toHaveProperty("campaign_id");
  });

  it("matches on visitor id or any rotating ip hash", async () => {
    state.existing = [{ id: "imp-earlier" }];
    await isDuplicateImpression({
      slotId: "slot-1",
      visitorId: "v-abc",
      ipHashes: ["c".repeat(32), "d".repeat(32)],
    });
    const or = String((state.lastQuery ?? {}).or ?? "");
    expect(or).toContain("visitor_id.eq.v-abc");
    expect(or).toContain(`ip_hash.eq.${"c".repeat(32)}`);
    // Yesterday's salt window still has to match after a rotation.
    expect(or).toContain(`ip_hash.eq.${"d".repeat(32)}`);
  });

  it("returns false when there is nothing to dedupe on", async () => {
    // No visitor and no IP: a terminal with no ?v= behind an unknown address.
    // Flagging those together would collapse unrelated viewers into one.
    const dup = await isDuplicateImpression({ slotId: "slot-1" });
    expect(dup).toBe(false);
    expect(state.lastQuery).toBeNull();
  });

  it("rejects identifiers that could inject PostgREST filter syntax", async () => {
    state.existing = [{ id: "imp-earlier" }];
    await isDuplicateImpression({
      slotId: "slot-1",
      visitorId: "v-abc,ip_hash.not.is.null",
      ipHashes: ["e".repeat(32)],
    });
    const or = String((state.lastQuery ?? {}).or ?? "");
    expect(or).not.toContain("ip_hash.not.is.null");
  });

  it("counts the impression rather than throwing when the probe fails", async () => {
    // Hot path on every fill: losing an impression (and the click that may
    // follow) is worse than counting one twice.
    state.throwOnSelect = true;
    const dup = await isDuplicateImpression({
      slotId: "slot-1",
      visitorId: "v-abc",
      ipHashes: ["f".repeat(32)],
    });
    expect(dup).toBe(false);
  });

  it("uses a much shorter window than the click path", async () => {
    // A repeat view hours later is real delivery; only a machine-driven burst
    // lands twice inside a minute.
    expect(IMPRESSION_DEDUPE_WINDOW_MS).toBe(60_000);
  });
});
