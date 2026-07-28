import { describe, it, expect } from "vitest";
import {
  buildFacets,
  buildPostRecord,
  truncateForBluesky,
} from "@/lib/sp/blueskyFacets";

/** What the facet actually highlights, resolved through UTF-8 bytes. */
function sliceByBytes(text: string, start: number, end: number): string {
  return Buffer.from(text, "utf8").subarray(start, end).toString("utf8");
}

describe("buildFacets — links", () => {
  it("links a bare URL", () => {
    const text = "Check out https://pairux.com/@moshcoding";
    const [f] = buildFacets(text);
    expect(f.features[0]).toEqual({
      $type: "app.bsky.richtext.facet#link",
      uri: "https://pairux.com/@moshcoding",
    });
    expect(sliceByBytes(text, f.index.byteStart, f.index.byteEnd)).toBe(
      "https://pairux.com/@moshcoding",
    );
  });

  it("leaves sentence punctuation outside the link", () => {
    const text = "See https://example.com.";
    const [f] = buildFacets(text);
    expect(f.features[0]).toMatchObject({ uri: "https://example.com" });
    expect(sliceByBytes(text, f.index.byteStart, f.index.byteEnd)).toBe("https://example.com");
  });

  it("finds several URLs", () => {
    expect(buildFacets("a https://one.test b https://two.test")).toHaveLength(2);
  });
});

describe("buildFacets — hashtags", () => {
  it("tags a hashtag without the #", () => {
    const text = "shipping #moshcoding today";
    const [f] = buildFacets(text);
    expect(f.features[0]).toEqual({ $type: "app.bsky.richtext.facet#tag", tag: "moshcoding" });
    expect(sliceByBytes(text, f.index.byteStart, f.index.byteEnd)).toBe("#moshcoding");
  });

  it("does not treat a URL fragment as a tag", () => {
    const facets = buildFacets("https://example.com/docs#install");
    expect(facets).toHaveLength(1);
    expect(facets[0].features[0].$type).toBe("app.bsky.richtext.facet#link");
  });

  it("ignores a purely numeric tag", () => {
    expect(buildFacets("ranked #1 today")).toHaveLength(0);
  });

  it("drops trailing punctuation from a tag", () => {
    const [f] = buildFacets("about #opensource, mostly");
    expect(f.features[0]).toMatchObject({ tag: "opensource" });
  });
});

describe("byte offsets, not string indices", () => {
  // The bug this guards: JS indices are UTF-16 units, facet offsets are
  // UTF-8 bytes. Anything multi-byte earlier in the string shifts them apart.
  it("stays correct after an emoji", () => {
    const text = "🚀 https://example.com";
    const [f] = buildFacets(text);
    expect(sliceByBytes(text, f.index.byteStart, f.index.byteEnd)).toBe("https://example.com");
    // A naive implementation would report the UTF-16 index of 2 here.
    expect(f.index.byteStart).toBe(5);
  });

  it("stays correct after CJK text", () => {
    const text = "日本語のテキスト https://example.com #tag";
    const facets = buildFacets(text);
    expect(sliceByBytes(text, facets[0].index.byteStart, facets[0].index.byteEnd)).toBe(
      "https://example.com",
    );
    expect(sliceByBytes(text, facets[1].index.byteStart, facets[1].index.byteEnd)).toBe("#tag");
  });

  it("stays correct after accented characters", () => {
    const text = "café société #naïve";
    const [f] = buildFacets(text);
    expect(sliceByBytes(text, f.index.byteStart, f.index.byteEnd)).toBe("#naïve");
  });

  it("returns facets sorted by start offset", () => {
    const facets = buildFacets("#one https://a.test #two https://b.test");
    const starts = facets.map((f) => f.index.byteStart);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("produces no overlapping ranges", () => {
    const facets = buildFacets("https://example.com/a#b #real");
    for (let i = 1; i < facets.length; i++) {
      expect(facets[i].index.byteStart).toBeGreaterThanOrEqual(facets[i - 1].index.byteEnd);
    }
  });
});

describe("truncateForBluesky", () => {
  it("leaves a short post alone", () => {
    expect(truncateForBluesky("hello")).toBe("hello");
  });

  it("counts emoji as one grapheme, not two units", () => {
    const text = "🚀".repeat(300);
    expect([...truncateForBluesky(text)].length).toBe(300);
  });

  it("never produces a lone surrogate when the cut lands on an emoji", () => {
    // 300 a's then an emoji: the cut falls exactly where slice() would split
    // the surrogate pair and emit invalid UTF-8.
    const out = truncateForBluesky("a".repeat(300) + "🚀");
    // A high surrogate not followed by a low, or a low not preceded by a high.
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(out).not.toMatch(LONE);
    // And it round-trips through UTF-8 unchanged, which is the real bar.
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);

    // Demonstrates the bug being fixed: the naive version does not survive.
    const naive = ("a".repeat(300) + "🚀").slice(0, 301);
    expect(naive).toMatch(LONE);
  });

  it("keeps a family emoji whole rather than splitting the sequence", () => {
    const out = truncateForBluesky("x".repeat(299) + "👨‍👩‍👧‍👦");
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
  });
});

describe("buildPostRecord", () => {
  it("omits facets entirely when there are none", () => {
    const r = buildPostRecord("just text", "2026-07-28T00:00:00Z");
    expect(r).not.toHaveProperty("facets");
    expect(r.$type).toBe("app.bsky.feed.post");
  });

  it("includes facets when the text has them", () => {
    const r = buildPostRecord("see https://example.com #tag", "2026-07-28T00:00:00Z");
    expect(r).toHaveProperty("facets");
  });

  it("builds facets against the truncated text, so offsets stay in range", () => {
    const text = "x".repeat(295) + " https://example.com/very/long/path #tag";
    const r = buildPostRecord(text, "2026-07-28T00:00:00Z");
    const bytes = Buffer.byteLength(r.text, "utf8");
    for (const f of (r as { facets?: { index: { byteEnd: number } }[] }).facets ?? []) {
      expect(f.index.byteEnd).toBeLessThanOrEqual(bytes);
    }
  });
});
