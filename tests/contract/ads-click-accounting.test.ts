import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  admitted: true, promo: false, free: false, inserts: [] as Record<string, unknown>[],
  rpc: vi.fn(), paper: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({
  rpc: state.rpc,
  from(table: string) {
    const q = {
      select: () => q, eq: () => q,
      insert(row: Record<string, unknown>) { state.inserts.push(row); return q; },
      maybeSingle: async () => ({ data: table === "ad_campaigns"
        ? { id: "campaign", destination_url: "https://example.com/offer", ref_slug: "ad-test", bid_credits: 4 }
        : { id: "click" } }),
    };
    return q;
  },
}) }));
vi.mock("@/lib/ads/fraud", async (original) => ({
  ...await original<object>(), assessClickValidity: async () => ({ valid: true }),
}));
vi.mock("@/lib/ads/click-cooldown", () => ({ claimClickCooldown: async () => ({
  allowed: state.admitted, reason: state.admitted ? undefined : "click_cooldown",
}) }));
vi.mock("@/lib/ads/promos", () => ({ promoForCampaign: async () => null }));
vi.mock("@/lib/ads/trending", async (original) => ({
  ...await original<object>(), promoState: () => ({ active: state.promo }),
}));
vi.mock("@/lib/ads/bids", () => ({ paperCharge: state.paper }));
import { resolveClick } from "@/lib/ads/serve";

beforeEach(() => {
  state.admitted = true; state.promo = false; state.free = false;
  state.inserts = []; state.rpc.mockReset(); state.paper.mockReset();
  state.rpc.mockImplementation(async () => ({ data: [{ click_id: "click", valid: !state.free, charged_cents: state.free ? 0 : 20 }] }));
});
const click = () => resolveClick({ campaignId: "campaign", slotId: "slot", ctx: { ip: "8.8.8.8", visitorId: "visitor" } });

describe("click admission before accounting", () => {
  it.each(["paid", "promo", "free"])("withholds %s accounting on a rejected click while preserving the destination", async (tier) => {
    state.admitted = false; state.promo = tier === "promo"; state.free = tier === "free";
    expect(await click()).toBe("https://example.com/offer?ref=ad-test");
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.paper).not.toHaveBeenCalled();
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ valid: false, tier: "paid", charged_cents: 0, publisher_earn_cents: 0 });
  });
  it("keeps admitted paid accounting intact", async () => {
    await click();
    expect(state.rpc).toHaveBeenCalledWith("ad_charge_click", expect.objectContaining({ p_campaign: "campaign", p_cpc_credits: 4 }));
    expect(state.paper).not.toHaveBeenCalled();
  });
  it("keeps admitted free-tier paper accounting separate from cash", async () => {
    state.free = true;
    await click();
    expect(state.paper).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clickId: "click" }));
  });
  it("keeps admitted promo clicks unbilled", async () => {
    state.promo = true;
    await click();
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.inserts[0]).toMatchObject({ tier: "free", charged_cents: 0, publisher_earn_cents: 0 });
    expect(state.paper).toHaveBeenCalledOnce();
  });
});
