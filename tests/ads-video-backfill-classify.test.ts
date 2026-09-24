import { describe, expect, it } from "vitest";
import { classifyCampaign } from "@/lib/ads/video/classify";

// Every URL below is a real shape taken from the production ad_campaigns table.
// The classifier decides what gets a rendered video, and the expensive mistake
// is the false positive: rendering a blog post that was explicitly excluded.
describe("blog posts are excluded, however they are shaped", () => {
  it("catches the own-site blog, which has no /blog/ prefix at the root", () => {
    // 152 campaigns look like this. A naive /^\/blog/ match misses every one,
    // because the blog lives under a tilde user directory.
    expect(classifyCampaign("https://dev.profullstack.com/~anthony/blog/126-post.html")).toBe("blog");
    expect(classifyCampaign("https://dev.profullstack.com/~anthony/blog/048-post.html")).toBe("blog");
  });

  it("catches dev.to articles, which look like ordinary deep links", () => {
    // 117 campaigns. The path is /<user>/<slug> with nothing blog-shaped in it,
    // so this has to be caught on the domain.
    expect(classifyCampaign("https://dev.to/chovy/nice-is-half-a-fix-ep9")).toBe("blog");
    expect(classifyCampaign("https://dev.to/chovy/the-bots-now-pay-the-humans-o43")).toBe("blog");
  });

  it("catches the other publishing platforms", () => {
    for (const u of [
      "https://medium.com/@someone/a-post-abc123",
      "https://someone.substack.com/p/a-post",
      "https://someone.hashnode.dev/a-post",
    ]) {
      expect(classifyCampaign(u), u).toBe("blog");
    }
  });

  it("catches conventional blog paths", () => {
    for (const u of [
      "https://example.com/blog/thing",
      "https://example.com/posts/thing",
      "https://example.com/news/thing",
      "https://example.com/article/thing",
    ]) {
      expect(classifyCampaign(u), u).toBe("blog");
    }
  });
});

describe("social links are excluded", () => {
  it("catches the platforms", () => {
    for (const u of [
      "https://x.com/someone",
      "https://twitter.com/someone/status/1",
      "https://bsky.app/profile/someone",
      "https://www.linkedin.com/in/someone",
      "https://t.me/somechannel",
      "https://www.reddit.com/r/something",
      "https://youtube.com/watch?v=abc",
    ]) {
      expect(classifyCampaign(u), u).toBe("social");
    }
  });
});

describe("product ads are kept", () => {
  it("keeps product homepages and deep links", () => {
    for (const u of [
      "https://moshcoding.com/",
      "https://outreachgraph.com/",
      "https://bl0ggers.com/",
      "https://weedforcrypto.com/",
      "https://profullstack.com/pricing",
      "https://openmcp.logicsrc.com/",
      "https://tronbrowser.dev/store/extension.html?slug=coinpay-wallet",
      "https://c0upons.com/coupons/647",
    ]) {
      expect(classifyCampaign(u), u).toBe("product");
    }
  });

  it("keeps affiliate and referral links — they advertise something buyable", () => {
    for (const u of [
      "https://m.do.co/c/f8b2890dc9d1",
      "https://www.amazon.com/Red-Bull-Energy-Drink-Pack/dp/B006O3ASKE?th=1",
      "https://goldclubhosting.xyz/aff.php?aff=362",
      "https://aiornot.vote/r/BAB9HME",
      "https://www.netcup.com/de/",
    ]) {
      expect(classifyCampaign(u), u).toBe("product");
    }
  });

  it("does not mistake a product path containing 'news' inside a word", () => {
    // Word-boundaried on path segments, so /newsletter-tool is a product.
    expect(classifyCampaign("https://example.com/newsletter-tool")).toBe("product");
  });
});

describe("an unparseable destination is skipped rather than rendered", () => {
  it("treats junk as non-product", () => {
    // Conservative direction: something we cannot show to be a product does not
    // get a render.
    expect(classifyCampaign("not a url")).not.toBe("product");
    expect(classifyCampaign("")).not.toBe("product");
  });
});
