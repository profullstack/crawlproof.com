import { beforeEach, describe, expect, it, vi } from "vitest";

// Serving with trending-topic targeting on.
//
// Two things have to be true at once and neither is provable from the pure
// matcher alone: a campaign whose subject is trending AND is what this page is
// about wins noticeably more fills than one that is neither, and a campaign
// inside its 90-day promo is metered exactly like any other ad while booking
// under a tier that can never move money.
//
// The mock is the same shape as tests/contract/ads-self-deal.test.ts: a proxy
// that answers every PostgREST builder call and resolves to whatever the table
// was set up to return.

const H = vi.hoisted(() => {
  const ADVERTISER = "11111111-1111-1111-1111-111111111111";
  const PUBLISHER = "22222222-2222-2222-2222-222222222222";
  return {
    ADVERTISER,
    PUBLISHER,
    state: {
      /** campaign id → the subjects it claims, for the opted-in campaigns. */
      optIns: {} as Record<string, string[]>,
      trends: [] as { topic: string; score: number }[],
      masterKeywords: ["dog walking"] as string[],
      promos: [] as Record<string, unknown>[],
      inserted: [] as Record<string, unknown>[],
      trendTableMissing: false,
    },
  };
});
const { ADVERTISER, PUBLISHER, state } = H;

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

function creativeFor(id: string, headline: string) {
  return {
    id: `cre-${id}`,
    campaign_id: id,
    format: "terminal_ascii",
    headline,
    body: "Real advertiser copy.",
    cta_text: "Go",
    image_url: null,
    logo_url: null,
    bg_color: "#0b0d10",
    fg_color: "#e7e9ee",
    accent_color: "#6ee7b7",
    font_family: "system-ui",
    ad_campaigns: {
      id,
      owner_id: ADVERTISER,
      status: "active",
      ref_slug: id,
      destination_url: "https://advertiser.example/",
      daily_budget_cents: 5000,
      spend_today_cents: 0,
      spend_date: null,
      bid_credits: 4,
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from(table: string) {
      if (table === "ad_slots") {
        return chain({
          data: {
            id: "slot-1",
            status: "active",
            formats: ["terminal_ascii"],
            // A different account owns the slot, so nothing here is a
            // self-deal and a paid booking is genuinely possible.
            owner_id: PUBLISHER,
            project_id: "project-1",
            niche: null,
          },
          error: null,
        });
      }
      if (table === "ad_creatives") {
        return chain({
          data: [creativeFor("camp-trending", "Trending advertiser"), creativeFor("camp-plain", "Plain advertiser")],
          error: null,
        });
      }
      if (table === "profiles") {
        return chain({ data: [{ id: ADVERTISER, credits_balance: 9999, ad_bonus_credits: 0 }], error: null });
      }
      if (table === "ad_campaigns") {
        // The opt-in read: campaigns with trending_topics = true.
        return chain({
          data: Object.entries(state.optIns).map(([id, topics]) => ({ id, topics })),
          error: null,
        });
      }
      if (table === "ad_trend_topics") {
        if (state.trendTableMissing) {
          return chain({ data: null, error: { message: 'relation "ad_trend_topics" does not exist' } });
        }
        return chain({
          data: state.trends.map((t) => ({
            source: "samebrain",
            topic: t.topic,
            mentions: 6,
            prior_mentions: 1,
            score: t.score,
            window_days: 7,
            generated_at: new Date().toISOString(),
            ingested_at: new Date().toISOString(),
          })),
          error: null,
        });
      }
      if (table === "lx_site") {
        return chain({ data: { master_keywords: state.masterKeywords, niche: "Local pet services" }, error: null });
      }
      if (table === "projects") {
        return chain({ data: { name: "Paws and Co" }, error: null });
      }
      if (table === "ad_promos") {
        return chain({ data: state.promos, error: null });
      }
      if (table === "ad_impressions") {
        return {
          insert(payload: Record<string, unknown>) {
            state.inserted.push(payload);
            return chain({ data: { id: "imp-1", ...payload }, error: null });
          },
        };
      }
      return chain({ data: null, error: null });
    },
  }),
}));

async function fills(n: number) {
  const { serveAd } = await import("@/lib/ads/serve");
  const out = [];
  for (let i = 0; i < n; i++) out.push(await serveAd("slot-1", "terminal_ascii", { device: "terminal" }));
  return out;
}

const DAY = 24 * 60 * 60 * 1000;

describe("trending-topic targeting decides who fills the page", () => {
  beforeEach(() => {
    vi.resetModules();
    state.optIns = { "camp-trending": ["dog walking"] };
    state.trends = [{ topic: "dog walking", score: 12 }];
    state.masterKeywords = ["dog walking"];
    state.promos = [];
    state.inserted = [];
    state.trendTableMissing = false;
  });

  it("prefers the campaign whose trending subject is what this page is about", async () => {
    const served = await fills(200);
    const real = served.filter((f) => f && f.campaignId !== "house");
    const trending = real.filter((f) => f!.campaignId === "camp-trending").length;
    const plain = real.filter((f) => f!.campaignId === "camp-plain").length;
    // A preference, not a rule: both bid 4 credits and the matched one carries
    // four times the weight, so it should take roughly 80% of fills.
    expect(trending).toBeGreaterThan(plain);
    // …and the other campaign must still rotate. "All ads rotate" is the
    // auction's hard requirement; a targeting feature that starved everything
    // else would break it.
    expect(plain).toBeGreaterThan(0);
  });

  it("says on the fill which subjects it was chosen for", async () => {
    const served = await fills(60);
    const match = served.find((f) => f && f.campaignId === "camp-trending");
    expect(match?.trendTopics).toEqual(["dog walking"]);
    const other = served.find((f) => f && f.campaignId === "camp-plain");
    expect(other?.trendTopics).toEqual([]);
  });

  it("prefers nobody when the page is about something else", async () => {
    state.masterKeywords = ["sourdough", "bread"];
    const served = await fills(200);
    const real = served.filter((f) => f && f.campaignId !== "house");
    const trending = real.filter((f) => f!.campaignId === "camp-trending").length;
    const plain = real.filter((f) => f!.campaignId === "camp-plain").length;
    // Even delivery, within the noise of a 200-fill lottery. The trending ad
    // must not follow its subject onto a page that has nothing to do with it.
    expect(Math.abs(trending - plain)).toBeLessThan(real.length * 0.35);
    expect(real.every((f) => (f!.trendTopics ?? []).length === 0)).toBe(true);
  });

  it("serves exactly as it did before when the trend table is not there yet", async () => {
    // The migration is applied by hand, so a deploy can lead it. A missing
    // table must read as "nothing is trending", never as an error.
    state.trendTableMissing = true;
    const served = await fills(60);
    const real = served.filter((f) => f && f.campaignId !== "house");
    expect(real.length).toBeGreaterThan(0);
    expect(real.every((f) => (f!.trendTopics ?? []).length === 0)).toBe(true);
  });
});

describe("a campaign inside its 90-day promo", () => {
  beforeEach(() => {
    vi.resetModules();
    state.optIns = { "camp-trending": ["dog walking"] };
    state.trends = [{ topic: "dog walking", score: 12 }];
    state.masterKeywords = ["dog walking"];
    state.inserted = [];
    state.trendTableMissing = false;
    state.promos = [
      {
        id: "promo-1",
        owner_id: ADVERTISER,
        campaign_id: "camp-trending",
        kind: "trending_premium_90",
        cpc_cents: 2,
        starts_at: new Date(Date.now() - 5 * DAY).toISOString(),
        ends_at: new Date(Date.now() + 85 * DAY).toISOString(),
        revoked_at: null,
      },
    ];
  });

  it("is metered like any other ad — the impression is still recorded", async () => {
    await fills(60);
    const promoRows = state.inserted.filter((row) => row.campaign_id === "camp-trending");
    expect(promoRows.length).toBeGreaterThan(0);
  });

  it("never books as paid, so no spend and no publisher earnings are invented", async () => {
    await fills(60);
    const promoRows = state.inserted.filter((row) => row.campaign_id === "camp-trending");
    expect(new Set(promoRows.map((row) => row.tier))).toEqual(new Set(["free"]));
    // The advertiser paying nothing does not make the OTHER advertiser free:
    // a funded campaign on somebody else's slot still books as paid.
    const plainRows = state.inserted.filter((row) => row.campaign_id === "camp-plain");
    expect(plainRows.length).toBeGreaterThan(0);
    expect(new Set(plainRows.map((row) => row.tier))).toEqual(new Set(["paid"]));
  });

  it("still carries the promo flag on the fill", async () => {
    const served = await fills(60);
    const match = served.find((f) => f && f.campaignId === "camp-trending");
    expect(match?.promo).toBe(true);
    expect(served.find((f) => f && f.campaignId === "camp-plain")?.promo).toBe(false);
  });
});
