import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/onion", () => ({ smartFetch: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: vi.fn() }));
const uploadHero = vi.fn();
vi.mock("@/lib/ads/heroImage", async (orig) => ({
  ...(await orig<typeof import("@/lib/ads/heroImage")>()),
  uploadHero: (...a: unknown[]) => uploadHero(...a),
}));

import {
  backfillAdHeroes,
  c0mputeImageTarget,
  domainOf,
  resetHeroBackfillState,
} from "@/lib/ads/heroBackfill";

const ENV = { C0MPUTE_SPEECH_URL: "http://gw:8787/", C0MPUTE_SPEECH_TOKEN: "t".repeat(32) };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);

function fakeSupabase(rows: unknown[]) {
  const updates: Array<{ values: unknown; campaign: unknown }> = [];
  const select = {
    is: () => select,
    eq: () => select,
    in: () => select,
    gte: () => select,
    order: () => select,
    limit: async () => ({ data: rows, error: null }),
  };
  const client = {
    from: () => ({
      select: () => select,
      update: (values: unknown) => {
        const u = { values, campaign: null as unknown };
        const chain = {
          eq: (_c: string, v: unknown) => ((u.campaign = v), chain),
          is: () => chain,
          select: async () => {
            updates.push(u);
            return { data: [{ id: "a" }, { id: "b" }], error: null };
          },
        };
        return chain;
      },
    }),
  };
  return { client: client as never, updates };
}

const row = {
  campaign_id: "c1",
  headline: "Ship faster",
  body: "CI in seconds",
  bg_color: "#101010",
  accent_color: "#ff6600",
  ad_campaigns: { destination_url: "https://www.example.dev/x", status: "active" },
};

describe("ad hero backfill on c0mpute", () => {
  beforeEach(() => {
    resetHeroBackfillState();
    uploadHero.mockReset();
  });

  it("targets the gateway's /v1/images and can be switched off", () => {
    expect(c0mputeImageTarget(ENV)).toEqual({ url: "http://gw:8787/v1/images", token: ENV.C0MPUTE_SPEECH_TOKEN });
    expect(c0mputeImageTarget({})).toBeNull();
    expect(c0mputeImageTarget({ ...ENV, AD_HERO_C0MPUTE: "0" })).toBeNull();
    expect(domainOf("https://www.example.dev/x")).toBe("example.dev");
  });

  it("draws one hero and writes it to the campaign's image-less creatives", async () => {
    const { client, updates } = fakeSupabase([row]);
    uploadHero.mockResolvedValue("https://cdn/heroes/1.webp");
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ width: 768, height: 512 });
      expect(body.prompt).toContain("Ship faster");
      expect(body.prompt).toContain("example.dev");
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    });
    const r = await backfillAdHeroes(client, { env: ENV, fetchImpl: fetchImpl as never });
    expect(r).toEqual({ campaignId: "c1", heroUrl: "https://cdn/heroes/1.webp", creativesUpdated: 2 });
    expect(updates).toEqual([{ values: { image_url: "https://cdn/heroes/1.webp" }, campaign: "c1" }]);
  });

  it("backs the whole sweep off when no worker is free (503)", async () => {
    const { client } = fakeSupabase([row]);
    const fetchImpl = vi.fn(async () => new Response("no worker", { status: 503 }));
    const now = 1_000_000;
    const first = await backfillAdHeroes(client, { env: ENV, fetchImpl: fetchImpl as never, now });
    expect(first.error).toMatch(/503/);
    const second = await backfillAdHeroes(client, { env: ENV, fetchImpl: fetchImpl as never, now: now + 60_000 });
    expect(second).toEqual({ skipped: "network_backoff" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips a campaign that failed on its own, and rejects non-PNG bytes", async () => {
    const { client } = fakeSupabase([row]);
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    const now = 5_000_000;
    expect((await backfillAdHeroes(client, { env: ENV, fetchImpl: fetchImpl as never, now })).error).toMatch(/not a PNG/);
    expect(await backfillAdHeroes(client, { env: ENV, fetchImpl: fetchImpl as never, now: now + 1 })).toEqual({
      skipped: "nothing_to_do",
    });
  });

  it("does nothing without a gateway", async () => {
    const { client } = fakeSupabase([row]);
    expect(await backfillAdHeroes(client, { env: {} })).toEqual({ skipped: "not_configured" });
  });
});
