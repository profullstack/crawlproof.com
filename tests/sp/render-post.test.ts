import { describe, it, expect } from "vitest";
import { assemblePostText, type RenderedPost } from "@/lib/sp/renderPost";

const BLUESKY_LIMIT = 300;
const X_LIMIT = 280;

function rendered(over: Partial<RenderedPost> = {}): RenderedPost {
  return { text: "Body.", hashtags: [], ...over };
}

describe("assemblePostText", () => {
  it("leaves a short post untouched", () => {
    // Hashtags arrive already "#"-prefixed from renderPostForPlatform.
    const out = assemblePostText({
      rendered: rendered({
        text: "Quick take on bot traffic.",
        hashtags: ["#seo"],
      }),
      url: "https://crawlproof.com/blog/bots",
      platform: "bluesky",
    });
    expect(out).toBe(
      "Quick take on bot traffic.\nhttps://crawlproof.com/blog/bots\n#seo",
    );
    expect(out.length).toBeLessThanOrEqual(BLUESKY_LIMIT);
  });

  it("clamps an over-limit Bluesky post (body + url + hashtags) to <= 300", () => {
    // Body alone is near the limit; url + hashtags would have pushed the old
    // assembler well past 300 (the reported 323-char failure).
    const out = assemblePostText({
      rendered: rendered({
        text: "A".repeat(290),
        hashtags: ["crawlproof", "seo", "bots"],
      }),
      url: "https://crawlproof.com/blog/some-long-article-slug",
      platform: "bluesky",
    });
    expect(out.length).toBeLessThanOrEqual(BLUESKY_LIMIT);
    // The URL is never sacrificed — it's the point of the post.
    expect(out).toContain("https://crawlproof.com/blog/some-long-article-slug");
    // Body was truncated with an ellipsis.
    expect(out).toContain("…");
  });

  it("drops hashtags before sacrificing the URL when room is tight", () => {
    const out = assemblePostText({
      rendered: rendered({
        text: "B".repeat(295),
        hashtags: ["one", "two", "three", "four", "five"],
      }),
      url: "https://crawlproof.com/x",
      platform: "bluesky",
    });
    expect(out.length).toBeLessThanOrEqual(BLUESKY_LIMIT);
    expect(out).toContain("https://crawlproof.com/x");
  });

  it("respects the tighter X limit of 280", () => {
    const out = assemblePostText({
      rendered: rendered({ text: "C".repeat(300), hashtags: ["growth"] }),
      url: "https://crawlproof.com/blog/post",
      platform: "x",
    });
    expect(out.length).toBeLessThanOrEqual(X_LIMIT);
    expect(out).toContain("https://crawlproof.com/blog/post");
  });

  it("does not truncate long-form platforms with generous limits", () => {
    const body = "D".repeat(1200);
    const out = assemblePostText({
      rendered: rendered({ text: body, hashtags: ["a", "b", "c"] }),
      url: "https://crawlproof.com/blog/post",
      platform: "linkedin",
    });
    expect(out).toContain(body);
    expect(out).not.toContain("…");
  });
});
