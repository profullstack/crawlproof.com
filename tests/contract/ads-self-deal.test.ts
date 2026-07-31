import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression: a self-owned campaign (same profile owns the slot and the
// campaign) used to be filtered out of the candidate list entirely. That is
// right on a network with other advertisers, and fatal on one without — while
// every slot and campaign belonged to a single account it removed 100% of
// inventory, every request fell through to the house ad, and because house
// fills are unmetered, impressions stopped being recorded at all.
//
// The rule that must survive: a self-deal can never win PAID inventory ahead of
// an advertiser who would actually pay. The rule that was wrong: dropping it.

// Declared inside vi.hoisted: the mock factory below is hoisted above ordinary
// const declarations, so it cannot close over them.
const H = vi.hoisted(() => {
  const OWNER = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";
  return {
    OWNER,
    OTHER,
    state: {
      slotOwner: OWNER as string | null,
      campaignOwners: [OWNER] as string[],
      credits: 9999,
      inserted: [] as Record<string, unknown>[],
    },
  };
});
const { OWNER, OTHER, state } = H;

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

function creativeFor(ownerId: string, i: number) {
  return {
    id: `cre-${i}`,
    campaign_id: `camp-${i}`,
    format: "terminal_ascii",
    headline: `Advertiser ${i}`,
    body: "Real advertiser copy.",
    cta_text: "Go",
    image_url: null,
    logo_url: null,
    bg_color: "#0b0d10",
    fg_color: "#e7e9ee",
    accent_color: "#6ee7b7",
    font_family: "system-ui",
    ad_campaigns: {
      id: `camp-${i}`,
      owner_id: ownerId,
      status: "active",
      ref_slug: `adv-${i}`,
      destination_url: "https://advertiser.example/",
      daily_budget_cents: 500,
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
            owner_id: state.slotOwner,
          },
          error: null,
        });
      }
      if (table === "ad_creatives") {
        return chain({
          data: state.campaignOwners.map((o, i) => creativeFor(o, i)),
          error: null,
        });
      }
      if (table === "profiles") {
        return chain({
          data: [...new Set(state.campaignOwners)].map((id) => ({
            id,
            credits_balance: state.credits,
            ad_bonus_credits: 0,
          })),
          error: null,
        });
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

async function serve() {
  const { serveAd } = await import("@/lib/ads/serve");
  return serveAd("slot-1", "terminal_ascii", { device: "terminal" });
}

/** Fill repeatedly, since ~10% of paid-eligible fills are house by design. */
async function fills(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await serve());
  return out;
}

describe("self-owned campaigns on a single-tenant network", () => {
  beforeEach(() => {
    vi.resetModules();
    state.slotOwner = OWNER;
    state.campaignOwners = [OWNER, OWNER, OWNER];
    state.credits = 9999;
    state.inserted = [];
  });

  it("still serves real creatives when the only campaigns are self-owned", async () => {
    const served = await fills(40);
    const real = served.filter((f) => f && f.campaignId !== "house");
    // The blackout: every one of these came back as the house ad.
    expect(real.length).toBeGreaterThan(0);
    expect(real[0]!.creative.headline).toMatch(/^Advertiser /);
  });

  it("records impressions again, so the dashboard is not blank", async () => {
    await fills(40);
    expect(state.inserted.length).toBeGreaterThan(0);
  });

  it("meters a self-deal as free, never as paid", async () => {
    await fills(40);
    const tiers = new Set(state.inserted.map((r) => r.tier));
    expect(tiers).toEqual(new Set(["free"]));
  });
});

describe("self-deal still loses to a real advertiser", () => {
  beforeEach(() => {
    vi.resetModules();
    state.slotOwner = OWNER;
    state.credits = 9999;
    state.inserted = [];
  });

  it("never gives paid inventory to the slot owner's own campaign", async () => {
    // One self-owned campaign, one genuine third-party advertiser.
    state.campaignOwners = [OWNER, OTHER];
    await fills(60);
    const paid = state.inserted.filter((r) => r.tier === "paid");
    expect(paid.length).toBeGreaterThan(0);
    // camp-0 is the self-owned one; it must never be billed against this slot.
    for (const row of paid) expect(row.campaign_id).toBe("camp-1");
  });

  it("puts a third-party advertiser on the paid tier", async () => {
    state.campaignOwners = [OTHER];
    await fills(40);
    expect(state.inserted.some((r) => r.tier === "paid")).toBe(true);
  });

  it("keeps a slot with no owner working", async () => {
    state.slotOwner = null;
    state.campaignOwners = [OWNER];
    await fills(40);
    expect(state.inserted.some((r) => r.tier === "paid")).toBe(true);
  });
});
