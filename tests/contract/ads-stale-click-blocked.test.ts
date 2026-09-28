import { beforeEach, describe, expect, it, vi } from "vitest";

// A click trailing its impression past the device ceiling is refused outright:
// no ad_clicks row, no redirect to the advertiser. Recording it as invalid and
// still redirecting is what kept the feed-link harvester coming back.

const state = vi.hoisted(() => ({
  validity: { valid: true } as { valid: boolean; reason?: string },
  inserts: [] as Record<string, unknown>[],
  rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({
  rpc: state.rpc,
  from(table: string) {
    const q = {
      select: () => q, eq: () => q,
      insert(row: Record<string, unknown>) { state.inserts.push(row); return q; },
      maybeSingle: async () => ({ data: table === "ad_campaigns"
        ? { id: "campaign", destination_url: "https://example.com/offer", ref_slug: "ad-test", bid_credits: 4 }
        : { visitor_id: "visitor" } }),
    };
    return q;
  },
}) }));
vi.mock("@/lib/ads/fraud", async (original) => ({
  ...await original<object>(), assessClickValidity: async () => state.validity,
}));
vi.mock("@/lib/ads/click-cooldown", () => ({ claimClickCooldown: async () => ({ allowed: true }) }));
vi.mock("@/lib/ads/promos", () => ({ promoForCampaign: async () => null }));
vi.mock("@/lib/ads/bids", () => ({ paperCharge: vi.fn() }));
import { BLOCKED_CLICK, resolveClick } from "@/lib/ads/serve";
import { blockedClickResponse } from "@/lib/ads/blocked-click";

beforeEach(() => {
  state.validity = { valid: true };
  state.inserts = [];
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ data: [{ click_id: "click", valid: true, charged_cents: 20 }] });
});

const click = () => resolveClick({
  campaignId: "campaign", slotId: "slot", impressionId: "imp",
  ctx: { ip: "8.8.8.8", visitorId: "visitor", device: "desktop" },
});

describe("stale ad clicks", () => {
  it("are refused: no row, no charge, no destination", async () => {
    state.validity = { valid: false, reason: "stale_impression" };
    expect(await click()).toBe(BLOCKED_CLICK);
    expect(state.inserts).toHaveLength(0);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("leave every other invalid click recorded and redirected", async () => {
    state.validity = { valid: false, reason: "duplicate" };
    expect(await click()).toBe("https://example.com/offer?ref=ad-test");
    expect(state.inserts).toHaveLength(1);
  });

  it("get a 410 that links nowhere and is kept by nothing", async () => {
    const res = blockedClickResponse();
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("nofollow");
    expect(await res.text()).not.toContain("example.com");
  });
});
