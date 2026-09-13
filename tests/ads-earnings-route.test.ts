import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), model: vi.fn(), delivery: vi.fn() }));
vi.mock("@/lib/sp/apiAuth", () => ({ authenticateBearer: mocks.auth }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({}) }));
vi.mock("@/lib/ads/earnings-data", () => ({ loadEarnings: mocks.model }));
vi.mock("@/lib/ads/token-earnings", () => ({ loadTokenDelivery: mocks.delivery }));
import { GET } from "@/app/api/ads/v1/earnings/route";
beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ ok: true, userId: "authenticated-owner" });
  mocks.delivery.mockReset().mockResolvedValue({});
  mocks.model.mockReset().mockResolvedValue({ statsUnavailable: false, totals: { pubClicks: 123 } });
});
describe("earnings response integrity", () => {
  it("uses the token owner, ignoring caller-supplied ownership", async () => {
    const r = await GET(new NextRequest("https://crawlproof.com/api/ads/v1/earnings?days=7&owner=attacker"));
    expect(r.status).toBe(200);
    expect(mocks.delivery).toHaveBeenCalledWith({}, "authenticated-owner", 7);
    expect(await r.json()).toMatchObject({ deliveryWindow: "range", totals: { pubClicks: 123 } });
  });
  it("returns retryable 503 with no fabricated totals for partial data", async () => {
    mocks.model.mockResolvedValue({ statsUnavailable: true, totals: { pubClicks: 0 } });
    const r = await GET(new NextRequest("https://crawlproof.com/api/ads/v1/earnings?days=7"));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect((await r.json()).totals).toBeUndefined();
  });
  it("does not run reporting for an unauthenticated request", async () => {
    mocks.auth.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    expect((await GET(new NextRequest("https://crawlproof.com/api/ads/v1/earnings"))).status).toBe(401);
    expect(mocks.delivery).not.toHaveBeenCalled();
  });
});
