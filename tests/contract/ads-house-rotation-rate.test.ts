import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOUSE_AD_ROTATION_RATE } from "@/lib/ads/house";

// serveAd hands HOUSE_AD_ROTATION_RATE of otherwise-fillable requests to the
// house ad, so the network keeps promoting itself on slots that are already
// selling. That branch is the only thing standing between "we advertise
// ourselves" and "we silently stopped", and it is easy to lose: it is one
// comparison, and the file that used to exercise it now pins the rate to 0 to
// stay deterministic (tests/contract/ads-short-code-serving.test.ts).
//
// ads-house-rotation.test.ts does not cover it either — that file calls
// houseFill() directly and never goes through serveAd, so it pins what a house
// ad *looks like*, not when one is served.
//
// So the rate is pinned here, against serveAd, by controlling the draw rather
// than sampling it. Asserting a ~10% frequency over N fills would mean
// reintroducing exactly the coin flip that made the other file flaky; driving
// the draw to each side of the threshold tests the same behaviour and cannot
// fail intermittently.

const state = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[] }));

const SLOT = {
  id: "slot-1",
  status: "active",
  formats: ["terminal_ascii"],
  owner_id: "pub-1",
};

// One funded, in-budget campaign, so serveAd has paid inventory and therefore
// reaches the rotation branch at all. With an empty auction it would fall
// through to the free/house backfill for unrelated reasons.
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
  return serveAd("slot-1", "terminal_ascii", { device: "terminal", src: "motd" });
}

describe("house ad rotation rate in serveAd", () => {
  beforeEach(() => {
    vi.resetModules();
    state.inserts = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives the house ad the fills whose draw falls under the rate", async () => {
    vi.spyOn(Math, "random").mockReturnValue(HOUSE_AD_ROTATION_RATE / 2);
    const fill = await serve();
    expect(fill?.campaignId).toBe("house");
  });

  it("does not meter a house fill", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    await serve();
    // No impression row: nothing exists for a click to charge against, which is
    // what "unmetered" has to mean in practice. A house ad that wrote an
    // impression would bill a publisher for the network's own promotion.
    expect(state.inserts).toHaveLength(0);
  });

  it("keeps the fill paid when the draw lands exactly on the rate", async () => {
    // The comparison is `<`, so the rate itself is not a house fill. Pinning the
    // boundary means a slip to `<=` fails here, rather than surviving as a
    // rotation that is fractionally off and that nobody would ever notice.
    vi.spyOn(Math, "random").mockReturnValue(HOUSE_AD_ROTATION_RATE);
    const fill = await serve();
    expect(fill?.campaignId).toBe("camp-1");
    expect(state.inserts).toHaveLength(1);
  });

  it("serves paid inventory on the great majority of fills", async () => {
    // Guards the direction of the comparison as well as its boundary: were the
    // branch inverted, the rate would still be "applied" and both tests above
    // would still pass, but ~90% of fills would go unpaid.
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    expect((await serve())?.campaignId).toBe("camp-1");
  });
});
