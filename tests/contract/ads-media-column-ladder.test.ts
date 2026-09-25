import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHORT_CODE_RE } from "@/lib/ads/shortcode";

// serveAd writes `media` — which arm of the presentation rotation a fill was —
// onto the impression, and that column arrives in a migration this repo applies
// by hand. If the deploy wins that race, an insert naming it fails.
//
// The failure mode these pin is specifically NOT "serving breaks": it is that a
// missing `media` column must not take short_code, src, duplicate and
// bid_credits down with it. Postgres rejects an insert naming any unknown
// column, so folding `media` into the existing optional group would mean one
// absent reporting column silently reverting every click URL to the long UUID
// form and stopping dedupe flags network-wide. Each optional column's absence
// has to be paid for by that column alone.

const state = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  /** false simulates a database that has `short_code` but not yet `media`. */
  hasMediaColumn: true,
  /** false simulates a database missing the older optional group as well. */
  hasShortCodeColumns: true,
}));

const SLOT = {
  id: "slot-1",
  status: "active",
  formats: ["banner_300x250"],
  owner_id: "pub-1",
  theme: "dark",
};

const CREATIVE = {
  id: "cre-1",
  campaign_id: "camp-1",
  format: "banner_300x250",
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

// Same reason as ads-short-code-serving: the 10% house diversion is unmetered
// and would flake every assertion about a paid impression row.
vi.mock("@/lib/ads/house", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ads/house")>()),
  HOUSE_AD_ROTATION_RATE: 0,
}));

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    storage: {
      from: () => ({ getPublicUrl: (key: string) => ({ data: { publicUrl: `https://cdn/${key}` } }) }),
    },
    from(table: string) {
      if (table === "ad_slots") return chain({ data: SLOT, error: null });
      // Both the candidate load and displayMediaFor's sibling lookup read this
      // table. The sibling lookup ends in maybeSingle and finds no video
      // creative here, which is the ordinary case: a campaign with no render.
      if (table === "ad_creatives") return chain({ data: [CREATIVE], error: null });
      if (table === "profiles") return chain({ data: [OWNER], error: null });
      if (table === "ad_impressions") {
        return {
          insert(payload: Record<string, unknown>) {
            state.inserts.push(payload);
            if ("media" in payload && !state.hasMediaColumn) {
              return chain({ data: null, error: { message: "column media does not exist" } });
            }
            if (
              ("short_code" in payload || "src" in payload) &&
              !state.hasShortCodeColumns
            ) {
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

async function serve() {
  const { serveAd } = await import("@/lib/ads/serve");
  return serveAd("slot-1", "banner_300x250", { device: "desktop" });
}

describe("recording which medium was served", () => {
  beforeEach(() => {
    vi.resetModules();
    state.inserts = [];
    state.hasMediaColumn = true;
    state.hasShortCodeColumns = true;
  });

  it("writes the medium onto the impression", async () => {
    const fill = await serve();
    expect(fill).not.toBeNull();
    expect(state.inserts).toHaveLength(1);
    // Nothing is rendered for this campaign, so the rotation has one arm.
    expect(state.inserts[0].media).toBe("static");
    expect(fill!.media).toBe("static");
  });

  it("keeps short_code when only the media column is missing", async () => {
    state.hasMediaColumn = false;
    const fill = await serve();
    expect(fill).not.toBeNull();
    // Exactly two attempts: with media, then without it — NOT all the way down
    // to the bare row.
    expect(state.inserts).toHaveLength(2);
    expect(state.inserts[0]).toHaveProperty("media");
    expect(state.inserts[1]).not.toHaveProperty("media");
    // The rung that matters: the older optional group survived.
    expect(state.inserts[1].short_code).toMatch(SHORT_CODE_RE);
    expect(state.inserts[1]).toHaveProperty("duplicate");
    expect(state.inserts[1]).toHaveProperty("bid_credits");
    // And the click is still addressed by the short code, not the UUID.
    expect(fill!.clickUrl).toContain("&cr=");
  });

  it("still reports the medium on the fill when the column could not store it", async () => {
    state.hasMediaColumn = false;
    const fill = await serve();
    // The rendering decision is not contingent on the reporting column: the
    // publisher gets the rotated unit either way.
    expect(fill!.media).toBe("static");
  });

  it("steps all the way down when the older columns are missing too", async () => {
    state.hasMediaColumn = false;
    state.hasShortCodeColumns = false;
    const fill = await serve();
    expect(fill).not.toBeNull();
    expect(state.inserts).toHaveLength(3);
    expect(state.inserts[2]).not.toHaveProperty("media");
    expect(state.inserts[2]).not.toHaveProperty("short_code");
    // The impression is still recorded, so the click still meters.
    expect(state.inserts[2]).toMatchObject({ slot_id: "slot-1", campaign_id: "camp-1" });
  });
});
