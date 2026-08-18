import { describe, it, expect } from "vitest";
import {
  parseKeywords,
  slugifyKeyword,
  topicFeedUrl,
  topicPageUrl,
} from "@/lib/promote/keywords";

describe("slugifyKeyword", () => {
  it("lowercases a simple keyword", () => {
    expect(slugifyKeyword("Bitcoin")).toBe("bitcoin");
  });

  it("hyphenates multi-word keywords, matching how RSS Amplifier slugs topics", () => {
    // Live check: /topics/artificial-intelligence.rss is a real feed,
    // /topics/artificial%20intelligence.rss is not.
    expect(slugifyKeyword("artificial intelligence")).toBe("artificial-intelligence");
    expect(slugifyKeyword("  AI   Agent  ")).toBe("ai-agent");
  });

  it("strips punctuation and diacritics", () => {
    expect(slugifyKeyword("C++ programming!")).toBe("c-programming");
    expect(slugifyKeyword("café culture")).toBe("cafe-culture");
  });

  it("rejects input with nothing usable in it", () => {
    expect(slugifyKeyword("")).toBeNull();
    expect(slugifyKeyword("   ")).toBeNull();
    expect(slugifyKeyword("!!!")).toBeNull();
  });

  it("never emits a trailing hyphen when it truncates", () => {
    const slug = slugifyKeyword("a".repeat(78) + " bb")!;
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("parseKeywords", () => {
  it("splits a comma-separated list into one source per keyword", () => {
    expect(parseKeywords("bitcoin,blockchain,ethereum").map((k) => k.slug)).toEqual([
      "bitcoin",
      "blockchain",
      "ethereum",
    ]);
  });

  it("splits on newlines too", () => {
    expect(parseKeywords("bitcoin\nblockchain").map((k) => k.slug)).toEqual([
      "bitcoin",
      "blockchain",
    ]);
  });

  it("does NOT split on spaces — a phrase is one keyword", () => {
    const parsed = parseKeywords("artificial intelligence");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe("artificial-intelligence");
  });

  it("keeps the display label the user typed", () => {
    expect(parseKeywords("  Artificial   Intelligence ")[0]).toEqual({
      slug: "artificial-intelligence",
      label: "Artificial Intelligence",
    });
  });

  it("deduplicates keywords that normalize to the same topic", () => {
    expect(parseKeywords("Bitcoin, bitcoin , BITCOIN").map((k) => k.slug)).toEqual([
      "bitcoin",
    ]);
  });

  it("drops empty entries from sloppy input", () => {
    expect(parseKeywords("bitcoin,,  ,\n\nethereum,").map((k) => k.slug)).toEqual([
      "bitcoin",
      "ethereum",
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseKeywords("")).toEqual([]);
  });
});

describe("topic URLs", () => {
  it("builds the feed URL the spec calls for", () => {
    expect(topicFeedUrl("bitcoin")).toBe("https://rssamplifier.com/topics/bitcoin.rss");
  });

  it("builds the human-facing topic page URL", () => {
    expect(topicPageUrl("bitcoin")).toBe("https://rssamplifier.com/topics/bitcoin");
  });

  it("honours an override base without doubling the slash", () => {
    expect(topicFeedUrl("bitcoin", "https://staging.example.com/")).toBe(
      "https://staging.example.com/topics/bitcoin.rss",
    );
  });
});
