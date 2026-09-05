import { describe, expect, it } from "vitest";
import { adFromUrl, bucketLabel, categorize } from "@/lib/tracker/categorize";
import { kindFromBucket } from "@/lib/tracker/humans";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

describe("ad attribution", () => {
  it("our own click redirect is the campaign's ref slug", () => {
    expect(adFromUrl("https://nichedb.dev/?ref=crawlproof-ad-072")).toBe("crawlproof-ad-072");
    expect(adFromUrl("/blog/043-post.html?ref=CrawlProof-Ad-3")).toBe("crawlproof-ad-3");
    // A ref that is not ours is not an ad.
    expect(adFromUrl("https://x.dev/?ref=producthunt")).toBeNull();
  });

  it("paid utm tags name the source; organic tags do not count", () => {
    expect(adFromUrl("https://x.dev/?utm_source=reddit&utm_medium=cpc")).toBe("reddit");
    expect(adFromUrl("https://x.dev/?utm_medium=paid")).toBe("unknown");
    expect(adFromUrl("https://x.dev/?utm_source=newsletter&utm_medium=email")).toBeNull();
    expect(adFromUrl("https://x.dev/?gclid=abc")).toBe("google");
    expect(adFromUrl(null)).toBeNull();
    expect(adFromUrl("::not a url::")).toBeNull();
  });

  it("an ad visit is bucketed as an ad, ahead of the referrer, and is human", () => {
    const hit = categorize({ referrer: "https://dev.profullstack.com/~anthony/blog/042-post.html", userAgent: CHROME, url: "https://nichedb.dev/?ref=crawlproof-ad-072" });
    expect(hit).toEqual({ bucket: "ad:crawlproof-ad-072", isAi: false });
    expect(kindFromBucket(hit.bucket)).toBe("human");
    expect(bucketLabel(hit.bucket)).toBe("Ad · crawlproof-ad-072");
  });

  it("a bot clicking an ad is still a bot", () => {
    expect(categorize({ referrer: null, userAgent: "Mozilla/5.0 (compatible; GPTBot/1.0)", url: "https://x.dev/?ref=crawlproof-ad-1" }).bucket).toBe("bot:gptbot");
  });

  it("nothing changes for a hit without a URL", () => {
    expect(categorize({ referrer: "https://t.co/abc", userAgent: CHROME }).bucket).toBe("social:twitter");
    expect(categorize({ referrer: null, userAgent: CHROME }).bucket).toBe("human:direct");
    expect(categorize({ referrer: "https://someblog.example/post", userAgent: CHROME, url: "https://x.dev/" }).bucket).toBe("referral:someblog.example");
  });
});
