import { describe, expect, it, vi } from "vitest";
import { loadTokenDelivery } from "@/lib/ads/token-earnings";
import { loadEarnings } from "@/lib/ads/earnings-data";

function stub(failMetadata = false) {
  const rows: Record<string, unknown[]> = {
    ad_campaigns: [{ id: "campaign", name: "Campaign", status: "active", destination_url: "https://example.com", total_spent_cents: 1550 }],
    projects: [{ id: "project", name: "example.com" }],
    ad_slots: [{ id: "slot", project_id: "project", status: "active" }], ad_ledger: [], ad_payouts: [],
  };
  const rpc = vi.fn().mockResolvedValue({ data: {
    campaigns: [{ campaign_id: "campaign", impressions: "10", free_impressions: "100", clicks: "2", free_clicks: "12", spent_cents: "40" }],
    slots: [{ slot_id: "slot", impressions: "10", free_impressions: "100", clicks: "2", free_clicks: "12", invalid_clicks: "250", earned_cents: "20" }], daily: [],
  }, error: null });
  const filters: Array<[string, string, unknown]> = [];
  const from = (table: string) => {
    const result: any = { select: () => result, eq: (field: string, value: unknown) => { filters.push([table, field, value]); return result; }, order: () => result,
      then: (resolve: (value: unknown) => void) => resolve({ data: rows[table], error: failMetadata ? { code: "57014" } : null }),
    };
    return result;
  };
  return { client: { rpc, from } as any, rpc, filters };
}

describe("API-token ad earnings", () => {
  it("keeps billed, free and rejected counts separate and populates domain rows", async () => {
    const { client, rpc, filters } = stub();
    const model = await loadEarnings(client, "owner", 7, loadTokenDelivery(client, "owner", 7));
    expect(rpc).toHaveBeenCalledExactlyOnceWith("ad_token_earnings", { p_owner: "owner", p_days: 7 });
    expect(model.statsUnavailable).toBe(false);
    expect(model.totals).toMatchObject({ pubImpressions: 110, pubClicks: 14, pubBilledClicks: 2, pubFreeClicks: 12, invalidClicks: 250, spentCents: 1550 });
    expect(model.campaigns[0]).toMatchObject({ clicks: 14, impressions: 110, spentCents: 40 });
    expect(model.slots[0]).toMatchObject({ clicks: 14, impressions: 110, earnedCents: 20 });
    expect(model.daily).toHaveLength(7);
    for (const [table, field, value] of filters.filter(([, field]) => field === "owner_id")) expect(value, table).toBe("owner");
  });
  it("rejects failed RPCs instead of returning zero delivery", async () => {
    const { client, rpc } = stub(); rpc.mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(loadTokenDelivery(client, "owner", 7)).rejects.toThrow("temporarily unavailable");
  });
  it("does not mistake a malformed response for an empty account", async () => {
    const { client, rpc } = stub(); rpc.mockResolvedValue({ data: {}, error: null });
    await expect(loadTokenDelivery(client, "owner", 7)).rejects.toThrow("temporarily unavailable");
  });
  it("flags failed balances or metadata as unavailable", async () => {
    const { client } = stub(true);
    expect((await loadEarnings(client, "owner", 7, loadTokenDelivery(client, "owner", 7))).statsUnavailable).toBe(true);
  });
});
