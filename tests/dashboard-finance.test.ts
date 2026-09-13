import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBusinessRevenue, collectFinance } from "@/lib/dashboard/collect";

const sdk = vi.hoisted(() => ({ snapshot: vi.fn(), analytics: vi.fn() }));
vi.mock("@profullstack/coinpay", () => ({ default: class CoinPayClient {} }));
vi.mock("@profullstack/coinpay/finances", () => ({
  collectFinanceSnapshot: sdk.snapshot,
  getFinanceAnalytics: sdk.analytics,
}));
afterEach(() => vi.resetAllMocks());

const analytics = (commission: number) => ({
  combined: { total_fees_usd: 999999 }, // Headline lifetime totals are not a rate.
  series: { points: [
    { total_commission_usd: commission, total_volume_usd: "100", total_count: 2 },
    { total_commission_usd: commission, total_volume_usd: "200", total_count: 3 },
  ] },
});

describe("collectBusinessRevenue", () => {
  it("keeps windowed totals under their business ids and isolates a failed request", async () => {
    const fetchAnalytics = vi.fn(async (id: string) => {
      if (id === "down") throw new Error("timeout");
      return analytics(id === "a" ? 2 : 10);
    });
    const result = await collectBusinessRevenue([{ id: "a" }, { id: "b" }, { id: "down" }, { id: "a" }, {}], 7, fetchAnalytics);
    expect(result.a).toEqual({ windowDays: 7, commissionUsd: 4, grossVolumeUsd: 300, transactions: 5 });
    expect(result.b?.commissionUsd).toBe(20);
    expect(result.down).toEqual({ windowDays: 7, error: "timeout" });
    expect(fetchAnalytics).toHaveBeenCalledTimes(3);
  });

  it("distinguishes a measured empty window from an absent or incomplete response", async () => {
    const empty = await collectBusinessRevenue([{ id: "a" }], 7, async () => ({ series: { points: [] } }));
    expect(empty.a?.commissionUsd).toBe(0);
    for (const response of [{}, { series: { points: [{ total_volume_usd: 100 }] } }]) {
      const result = await collectBusinessRevenue([{ id: "a" }], 7, async () => response);
      expect(result.a?.error).toBeTruthy();
      expect(result.a?.commissionUsd).toBeUndefined();
    }
  });
});

describe("collectFinance", () => {
  it.each([[7, "week"], [30, "month"]])("requests business ids with the server's %s-day preset", async (days, period) => {
    sdk.snapshot.mockResolvedValue({ businesses: [{ id: "a", name: "a.dev" }, { id: "b", name: "b.dev" }] });
    sdk.analytics.mockResolvedValue(analytics(2));
    const result = await collectFinance({ token: "test", baseUrl: "https://coinpay.test/api" }, days as number);
    expect(sdk.analytics).toHaveBeenCalledWith(expect.anything(), { businessId: "a", period });
    expect(sdk.analytics).toHaveBeenCalledWith(expect.anything(), { businessId: "b", period });
    expect(result.businessRevenue?.a?.commissionUsd).toBe(4);
  });
});
