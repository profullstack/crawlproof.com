import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintPass } from "@profullstack/x402-gateway";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/crawl-limits", () => ({
  limitCrawlRequest: mocks.limit, recordCrawlerOutcome: mocks.record,
  CRAWLER_IP_PER_MINUTE: 12, CRAWLER_FAMILY_PER_HOUR: 600,
}));
const SECRET = "test-crawl-secret-not-a-real-key";
const SEMRUSH = "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)";
function request(path = "/a/AbCdEf123456", ua = SEMRUSH, pass?: string, accept?: string, ip = "85.208.96.196") {
  return new Request(`https://crawlproof.com${path}`, { headers: {
    "user-agent": ua, "x-real-ip": ip, ...(pass ? { "x-crawl-pass": pass } : {}),
    ...(accept ? { accept } : {}),
  } });
}
beforeEach(() => {
  vi.resetModules(); mocks.limit.mockReset().mockResolvedValue(undefined); mocks.record.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("COINPAY_X402_KEY", SECRET); vi.stubEnv("CRAWL_PAY_TO", `0x${"1".repeat(40)}`);
  vi.stubEnv("SITE_URL", "https://crawlproof.com");
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
    // Googlebot from Google's published range (x402-gateway 0.10 checks the address).
    const google = "66.249.66.1";
    expect(await gate(request("/blog", "Googlebot", undefined, undefined, google))).toBeUndefined();
    expect((await gate(request("/a/AbCdEf123456", "Googlebot", undefined, undefined, google)))?.status).toBe(403);
    // The same string from anywhere else is an impostor and is charged.
    expect((await gate(request("/blog", "Googlebot")))?.status).toBe(402);
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
  it("explains in plain words what the $1 buys, without breaking the x402 fields", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    const response = await gate(request("/crawl", "curl/8.5.0"));
    expect(response?.status).toBe(402);
    expect(response!.headers.get("link")).toBe('<https://crawlproof.com/docs/crawl-access>; rel="help"');
    const body = await response!.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(3);
    for (const a of body.accepts) {
      expect(a).toMatchObject({ scheme: "exact", amount: "1000000", resource: "https://crawlproof.com/crawl", maxTimeoutSeconds: 300 });
      expect(a.description).toMatch(/\$1\.00 USDC buys a crawler pass/);
      expect(a.description).toMatch(/24 hours \(1440 minutes\)/);
      expect(a.description).toMatch(/not an error, not a test and not the site audit/);
    }
    expect(body.resource).toEqual({ url: "https://crawlproof.com/crawl", description: body.accepts[0].description, mimeType: "application/json" });
    expect(body.about.sample_response).toMatchObject({ ok: true, header: "x-crawl-pass", days: 1, minutes: 1440 });
    expect(body.about.docs).toBe("https://crawlproof.com/docs/crawl-access");
    expect(body.about.pay_without_an_x402_client.power_key).toBe("https://profullstack.com/shop");
    expect(body.about.pay_without_an_x402_client.browser_wallet).toContain("coinpay x402 pay https://crawlproof.com/crawl");
    expect(JSON.stringify(body)).not.toMatch(/stripe|credit card/i);
    expect(body.error).toMatch(/docs\/crawl-access/);
    expect(body.pass.price).toBe("1.00 USD");
  });
  it("prices a multi-day offer in the description too", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    const body = await (await gate(request("/crawl?days=7", "curl/8.5.0")))!.json();
    expect(body.accepts[0].amount).toBe("7000000");
    expect(body.accepts[0].description).toMatch(/\$7\.00 USDC .* 7 days \(10080 minutes\)/);
  });
  it("puts the same explanation at the top of the HTML page", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    const response = await gate(request("/crawl", "curl/8.5.0", undefined, "text/html"));
    expect(response?.status).toBe(402);
    const html = await response!.text();
    expect(html.indexOf("What this is")).toBeLessThan(html.indexOf("How it works"));
    expect(html).toContain("What $1 buys");
    expect(html).toContain("Pay without an x402 client");
    expect(html).toContain("&quot;header&quot;: &quot;x-crawl-pass&quot;");
    expect(html).toContain("https://crawlproof.com/docs/crawl-access");
  });
  it("lets a refused crawler read the docs for what it is asked to buy", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    expect((await gate(request("/blog", "Mozilla/5.0 (compatible; GPTBot/1.2)")))?.status).toBe(402);
    expect(await gate(request("/docs/crawl-access", "Mozilla/5.0 (compatible; GPTBot/1.2)"))).toBeUndefined();
  });
});

describe("headless browsers", () => {
  it("charges a self-declared headless browser like any paid crawler", async () => {
    const { gate } = await import("@/lib/crawl-gateway");
    expect((await gate(request("/blog", "Lightpanda/1.0")))?.status).toBe(402);
    expect((await gate(request("/blog", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36")))?.status).toBe(402);
  });
});
