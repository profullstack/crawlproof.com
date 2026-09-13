import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), profile: vi.fn(), counters: vi.fn() }));
vi.mock("@/lib/sp/apiAuth", () => ({ authenticateBearer: mocks.auth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.profile }) }) }) }) }));
vi.mock("@/lib/crawl-limits", () => ({ readCrawlerActivity: mocks.counters }));
import { GET } from "@/app/api/admin/crawl-activity/route";
beforeEach(() => {
 mocks.auth.mockReset().mockResolvedValue({ ok: true, userId: "owner" });
 mocks.profile.mockReset().mockResolvedValue({ data: { is_admin: false }, error: null });
 mocks.counters.mockReset().mockResolvedValue([]);
});
const req = () => new NextRequest("https://crawlproof.com/api/admin/crawl-activity?days=7", { headers: { authorization: "Bearer test" } });
describe("network crawler diagnostics access", () => {
 it("denies non-admin tokens without reading network counters", async () => {
  expect((await GET(req())).status).toBe(403); expect(mocks.counters).not.toHaveBeenCalled();
 });
 it("denies anonymous requests", async () => {
  expect((await GET(new NextRequest("https://crawlproof.com/api/admin/crawl-activity"))).status).toBe(401);
  expect(mocks.counters).not.toHaveBeenCalled();
 });
 it("returns explicitly network-scoped data to admins", async () => {
  mocks.profile.mockResolvedValue({ data: { is_admin: true }, error: null });
  const response = await GET(req()); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ scope: "network", rangeDays: 7, daily: [] });
 });
});
