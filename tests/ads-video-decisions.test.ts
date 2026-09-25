import { describe, expect, it } from "vitest";
import type { Fill } from "@/lib/ads/serve";
import {
  normalizePlacement,
  normalizeSurface,
  recordDecision,
} from "@/lib/ads/video/decisions";
import { videoFunnelRow, parseDays } from "@/lib/ads/video/stats";

const IMPRESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fill(over: Partial<Fill> = {}): Fill {
  return {
    impressionId: IMPRESSION,
    campaignId: "c1",
    creativeId: "cr1",
    refSlug: "crawlproof-ad-1",
    creative: {} as Fill["creative"],
    clickUrl: "https://crawlproof.com/api/ads/click?i=1",
    html: "",
    text: "",
    tier: "paid",
    ...over,
  };
}

/** Records the row an insert was given, and can fail the way Postgres would. */
function db(opts: { failFirst?: { code: string }; existing?: Record<string, unknown> } = {}) {
  const inserts: Record<string, unknown>[] = [];
  let calls = 0;
  return {
    inserts,
    from() {
      const b: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      Object.assign(b, {
        insert(row: Record<string, unknown>) {
          inserts.push(row);
          calls += 1;
          const fails = calls === 1 && opts.failFirst;
          return {
            select: () => ({
              maybeSingle: async () =>
                fails
                  ? { data: null, error: opts.failFirst }
                  : { data: { id: "decision-1" }, error: null },
            }),
          };
        },
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return b;
        },
        is: () => b,
        gt: () => b,
        maybeSingle: async () => ({ data: opts.existing ?? null }),
      });
      return b;
    },
  };
}

describe("recordDecision", () => {
  it("records a paid fill with its campaign, creative and impression", async () => {
    const sb = db();
    const id = await recordDecision(sb as never, {
      slotId: "slot-1",
      sessionId: "sess-1",
      placement: "preroll",
      kind: "audio",
      surface: "web",
      fill: fill(),
      assetRevision: 3,
    });
    expect(id).toBe("decision-1");
    expect(sb.inserts[0]).toMatchObject({
      slot_id: "slot-1",
      playback_session_id: "sess-1",
      result: "ad",
      tier: "paid",
      campaign_id: "c1",
      creative_id: "cr1",
      impression_id: IMPRESSION,
      asset_revision: 3,
      presentation_kind: "audio",
      property_id: null,
    });
  });

  it("does not write the literal house ids into the foreign keys", async () => {
    const sb = db();
    await recordDecision(sb as never, {
      slotId: "slot-1",
      sessionId: "sess-1",
      placement: "preroll",
      kind: "video",
      surface: "web",
      fill: fill({ tier: "house", campaignId: "house", creativeId: "house" }),
      assetRevision: 1,
    });
    expect(sb.inserts[0]).toMatchObject({
      result: "house",
      tier: "house",
      campaign_id: null,
      creative_id: null,
      // Never metered, so there is no impression to point at.
      impression_id: null,
    });
  });

  it("records an empty break so a slot that fills nothing is not invisible", async () => {
    const sb = db();
    await recordDecision(sb as never, {
      slotId: "slot-1",
      sessionId: "sess-1",
      placement: "preroll",
      kind: "audio",
      surface: "web",
      fill: null,
      assetRevision: null,
      reason: "no_fill",
    });
    expect(sb.inserts[0]).toMatchObject({
      result: "no_ad",
      reason: "no_fill",
      campaign_id: null,
      impression_id: null,
      tier: null,
    });
  });

  it("retries without the impression link when the ledger row does not exist", async () => {
    // serveAd synthesises an impression id when its own insert failed, so the
    // foreign key can reject an otherwise good row.
    const sb = db({ failFirst: { code: "23503" } });
    const id = await recordDecision(sb as never, {
      slotId: "slot-1",
      sessionId: "sess-1",
      placement: "preroll",
      kind: "audio",
      surface: "web",
      fill: fill(),
      assetRevision: 1,
    });
    expect(id).toBe("decision-1");
    expect(sb.inserts).toHaveLength(2);
    expect(sb.inserts[1].impression_id).toBeNull();
  });

  it("returns the winner's decision when two requests race for one session", async () => {
    const sb = db({ failFirst: { code: "23505" }, existing: { id: "decision-winner" } });
    const id = await recordDecision(sb as never, {
      slotId: "slot-1",
      sessionId: "sess-1",
      placement: "preroll",
      kind: "audio",
      surface: "web",
      fill: fill(),
      assetRevision: 1,
    });
    expect(id).toBe("decision-winner");
  });
});

describe("normalizers", () => {
  it("refuses an unbounded placement, which would mint unlimited pre-rolls per session", () => {
    expect(normalizePlacement("midroll")).toBe("midroll");
    expect(normalizePlacement("anything-i-like")).toBe("preroll");
    expect(normalizePlacement(null)).toBe("preroll");
  });

  it("falls back to web for a surface the schema would reject", () => {
    expect(normalizeSurface("tui")).toBe("tui");
    expect(normalizeSurface("playstation")).toBe("web");
  });
});

describe("funnel rates", () => {
  it("divides completions by starts, not by fills", () => {
    const row = videoFunnelRow({
      campaign_id: "c1",
      campaign_name: "Demo",
      fills: 100,
      starts: 50,
      completes: 25,
    });
    // 25 of 50 that played, not 25 of 100 that were chosen.
    expect(row.completionRate).toBe(0.5);
    expect(row.startRate).toBe(0.5);
  });

  it("reports zero rather than NaN when nothing played", () => {
    const row = videoFunnelRow({ fills: 0, starts: 0, completes: 0 });
    expect(row.startRate).toBe(0);
    expect(row.completionRate).toBe(0);
  });

  it("clamps the window", () => {
    expect(parseDays("1000")).toBe(365);
    expect(parseDays("0")).toBe(1);
    expect(parseDays(null)).toBe(7);
    expect(parseDays("nonsense")).toBe(7);
  });
});
