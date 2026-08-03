import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHORT_CODE_RE } from "@/lib/ads/shortcode";
import { HOUSE_AD_ROTATION_RATE } from "@/lib/ads/house";

// serveAd now writes two new columns (short_code, src) that only exist after a
// migration this repo applies by hand. If the deploy wins that race, an insert
// naming them fails — and since the impression row is what a click resolves
// back to, a naive version would take *all* paid serving down until someone
// noticed. These pin the fallback: retry without the new columns, keep serving,
// and address the click by UUID instead.

const state = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  // Set false to simulate a database that has not had the migration applied.
  hasNewColumns: true,
}));

const SLOT = {
  id: "slot-1",
  status: "active",
  formats: ["terminal_ascii"],
  owner_id: "pub-1",
};

const CREATIVE = {
  id: "cre-1",
  campaign_id: "camp-1",
  format: "terminal_ascii",
  headline: "Ship faster",
  body: "One command.",
  cta_text: "Try it",
  image_url: null,
  logo_url: null,
  bg_color: "#0b0d10",
  fg_color: "#e7e9ee",
  accent_color: "#6ee7b7",
  font_family: "system-ui",
  ad_campaigns: {
    id: "camp-1",
    owner_id: "adv-1",
    status: "active",
    ref_slug: "acme",
    destination_url: "https://advertiser.example/",
    daily_budget_cents: 500,
    spend_today_cents: 0,
    spend_date: null,
    bid_credits: 4,
  },
};

const OWNER = { id: "adv-1", credits_balance: 1000, ad_bonus_credits: 0 };

/** A thenable stub: every builder method chains, awaiting yields `result`. */
function chain(result: unknown): unknown {
  const c: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(result).then(res, rej);
        }
        return () => c;
      },
    },
  );
  return c;
}

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from(table: string) {
      if (table === "ad_slots") return chain({ data: SLOT, error: null });
      if (table === "ad_creatives") return chain({ data: [CREATIVE], error: null });
      if (table === "profiles") return chain({ data: [OWNER], error: null });
      if (table === "ad_impressions") {
        return {
          insert(payload: Record<string, unknown>) {
            state.inserts.push(payload);
            const namesNewColumns = "short_code" in payload || "src" in payload;
            if (namesNewColumns && !state.hasNewColumns) {
              // PostgREST on an unknown column: no row comes back.
              return chain({ data: null, error: { message: "column does not exist" } });
            }
            return chain({
              data: { id: "11111111-2222-3333-4444-555555555555", ...payload },
              error: null,
            });
          },
        };
      }
      return chain({ data: null, error: null });
    },
  }),
}));

async function serve(src: string | null = "motd") {
  const { serveAd } = await import("@/lib/ads/serve");
  return serveAd("slot-1", "terminal_ascii", { device: "terminal", src });
}

describe("serveAd short-code click URLs", () => {
  beforeEach(() => {
    vi.resetModules();
    state.inserts = [];
    state.hasNewColumns = true;
    // serveAd diverts HOUSE_AD_ROTATION_RATE (~10%) of otherwise-fillable
    // requests to the house ad, which is unmetered: no impression row, so no
    // short code and no /a/ click URL. Left to chance, four of the tests below
    // read `undefined` off a house fill on ~10% of runs each — roughly one CI
    // run in three failed, on whichever test happened to draw it, and said
    // nothing about the change under review.
    //
    // These tests are about the click URL of a *paid* fill, so the draw is
    // pinned above the threshold. Fixing Math.random is safe precisely here:
    // the auction has a single candidate either way, and short codes come from
    // crypto.randomBytes, so "issues a distinct code per paid fill" still
    // exercises real entropy. The rotation itself is pinned separately below.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("addresses the click by short code once the columns exist", async () => {
    const fill = await serve();
    expect(fill).not.toBeNull();
    const code = fill!.clickUrl.split("/a/")[1];
    expect(code).toMatch(SHORT_CODE_RE);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].short_code).toMatch(SHORT_CODE_RE);
  });

  it("records the publisher surface tag on the impression, not in the URL", async () => {
    const fill = await serve("bbs");
    expect(state.inserts[0].src).toBe("bbs");
    // The tag must not cost box width by riding along in the printed URL.
    expect(fill!.clickUrl).not.toContain("bbs");
    expect(fill!.clickUrl).not.toContain("?");
  });

  it("keeps serving when the migration has not been applied yet", async () => {
    state.hasNewColumns = false;
    const fill = await serve();
    expect(fill).not.toBeNull();
    // Two attempts: the first naming the new columns, the second without them.
    expect(state.inserts).toHaveLength(2);
    expect(state.inserts[0]).toHaveProperty("short_code");
    expect(state.inserts[1]).not.toHaveProperty("short_code");
    expect(state.inserts[1]).not.toHaveProperty("src");
    // The impression is still recorded, so the click still meters.
    expect(state.inserts[1]).toMatchObject({ slot_id: "slot-1", campaign_id: "camp-1" });
  });

  it("falls back to the UUID click URL when the code could not be stored", async () => {
    state.hasNewColumns = false;
    const fill = await serve();
    const ref = fill!.clickUrl.split("/a/")[1];
    expect(ref).not.toMatch(SHORT_CODE_RE);
    expect(ref).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("issues a distinct code per paid fill", async () => {
    // Every draw takes the paid path (see beforeEach), so all 60 fills carry a
    // code. The codes come from crypto.randomBytes, which the stub does not
    // touch — this is still a real uniqueness check, just no longer a partial
    // one that silently shrank whenever the house ad turned up.
    const codes: string[] = [];
    for (let i = 0; i < 60; i++) {
      const fill = await serve();
      expect(fill!.campaignId).not.toBe("house");
      codes.push(fill!.clickUrl.split("/a/")[1]!);
    }
    expect(codes).toHaveLength(60);
    for (const code of codes) expect(code).toMatch(SHORT_CODE_RE);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // Pinning the draw above would quietly delete the only coverage of the
  // rotation, so it is asserted directly instead of statistically — the
  // boundary is the interesting part, and a sampled rate would just be a
  // slower way to reintroduce a flaky test.
  it("gives the unmetered house ad the fills that draw under the rate", async () => {
    vi.spyOn(Math, "random").mockReturnValue(HOUSE_AD_ROTATION_RATE / 2);
    const fill = await serve();
    expect(fill!.campaignId).toBe("house");
    // Unmetered: no impression row, so nothing can be charged for the click.
    expect(state.inserts).toHaveLength(0);
    expect(fill!.clickUrl).not.toContain("/a/");
  });

  it("keeps the fill paid when the draw lands exactly on the rate", async () => {
    // The comparison is `<`, so the rate itself is not a house fill. Pinning
    // the boundary means a change to `<=` fails here rather than showing up as
    // a slightly-off rotation nobody notices.
    vi.spyOn(Math, "random").mockReturnValue(HOUSE_AD_ROTATION_RATE);
    const fill = await serve();
    expect(fill!.campaignId).toBe("camp-1");
    expect(fill!.clickUrl).toContain("/a/");
  });
});
