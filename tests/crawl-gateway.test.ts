import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintPass } from "@profullstack/x402-gateway";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/crawl-limits", () => ({
  limitCrawlRequest: mocks.limit, recordCrawlerOutcome: mocks.record,
  CRAWLER_IP_PER_MINUTE: 12, CRAWLER_FAMILY_PER_HOUR: 600,
}));
const SECRET = "test-crawl-secret-not-a-real-key";
const SEMRUSH = "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)";
function request(path = "/a/AbCdEf123456", ua = SEMRUSH, pass?: string) {
  return new Request(`https://crawlproof.com${path}`, { headers: {
    "user-agent": ua, "x-real-ip": "85.208.96.196", ...(pass ? { "x-crawl-pass": pass } : {}),
  } });
}
beforeEach(() => {
  vi.resetModules(); mocks.limit.mockReset().mockResolvedValue(undefined); mocks.record.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("COINPAY_X402_KEY", SECRET); vi.stubEnv("CRAWL_PAY_TO", `0x${"1".repeat(40)}`);
});
afterEach(() => vi.unstubAllEnvs());

describe("crawler access through x402-gateway", () => {
  it("offers a priced module day pass to commercial crawlers", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    const response = await gate(request());
    expect(response?.status).toBe(402);
    const body = await response!.json();
    expect(body.accepts.length).toBeGreaterThan(0);
    expect(body.pass.minutes).toBe(1440);
    expect(body.pass.price).toBe("1.00 USD");
    expect(mocks.limit).toHaveBeenCalledWith(expect.any(Request), "semrushbot", "ad");
  });
  it("admits a valid signed pass and rejects a forged one", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    const pass = await mintPass({ secret: SECRET, ref: "test", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    expect(await gate(request("/a/AbCdEf123456", SEMRUSH, pass.token))).toBeUndefined();
    expect((await gate(request("/a/AbCdEf123456", SEMRUSH, "cp_forged.signature")))?.status).toBe(402);
  });
  it("throttles even paid crawlers before processing their pass or payment", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    const pass = await mintPass({ secret: SECRET, ref: "test", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    mocks.limit.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    expect((await gate(request("/a/AbCdEf123456", SEMRUSH, pass.token)))?.status).toBe(429);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("keeps human ad redirects free but limits their request rate", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    expect(await gate(request("/a/AbCdEf123456", "Mozilla/5.0 Chrome/120.0 Safari/537.36"))).toBeUndefined();
    expect(mocks.limit).toHaveBeenCalledWith(expect.any(Request), null, "ad");
  });
  it("allows search indexing of content while refusing unpaid ad redirects", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    expect(await gate(request("/blog", "Googlebot"))).toBeUndefined();
    expect((await gate(request("/a/AbCdEf123456", "Googlebot")))?.status).toBe(403);
  });
  it("keeps all generated robots groups away from ad redirects", async () => {
    const { gateway } = await import("@/lib/crawl-gateway");
    const txt = gateway.robotsTxt({ disallow: ["/api/", "/a/"] });
    for (const group of txt.split(/\n\n+/).filter((g) => g.startsWith("User-agent:"))) {
      expect(group).toMatch(/Disallow: \/a\/|Disallow: \/\n/);
    }
    expect(txt).toContain("User-agent: SemrushBot\nDisallow: /\nAllow: /crawl");
  });
  it("explains the same rate limits to paying operators", async () => {
    const { gateway } = await import("@/lib/crawl-gateway");
    expect(gateway.page()).toContain("Commercial and training crawlers");
    expect(gateway.page()).toContain("600 requests per hour");
    expect(gateway.page()).toContain("never count as ad clicks");
  });
});
