import { describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => db }));
import { resolveClick } from "@/lib/ads/serve";

describe("paid crawler link resolution", () => {
  it("resolves the destination without a click write, attribution, fraud query or charge", async () => {
    const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { id: "campaign", destination_url: "https://advertiser.example/", ref_slug: "ad-ref", status: "active", bid_credits: 1 } }) };
    db.from.mockImplementation((table) => { if (table !== "ad_campaigns") throw new Error(`Unexpected metering table: ${table}`); return chain; });
    const dest = await resolveClick({ campaignId: "campaign", impressionId: "impression", slotId: "slot", ctx: { device: "bot", ip: "85.208.96.196" } });
    expect(dest).toBe("https://advertiser.example/");
    expect(db.from).toHaveBeenCalledExactlyOnceWith("ad_campaigns");
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
