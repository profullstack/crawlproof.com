import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFeed, summarize } from "@/lib/promote/feedParse";

// A trimmed capture of the live https://rssamplifier.com/topics/bitcoin.rss —
// the exact shape a keyword source has to cope with, namespaces included.
const bitcoinFeed = readFileSync(
  join(__dirname, "fixtures", "rssamplifier-bitcoin.rss"),
  "utf8",
);

describe("parseFeed — RSS Amplifier topic feed", () => {
  const feed = parseFeed(bitcoinFeed, "https://rssamplifier.com/topics/bitcoin.rss");

  it("reads the channel title", () => {
    expect(feed.title).toBe("bitcoin — RSS Amplifier");
  });

  it("returns every item in the document", () => {
    expect(feed.items.length).toBe(4);
  });

  it("keeps the publisher's link, not the aggregator's", () => {
    for (const item of feed.items) {
      expect(item.url).toMatch(/^https?:\/\//);
      expect(new URL(item.url).hostname).not.toBe("rssamplifier.com");
    }
  });

  it("captures title, guid and publish date", () => {
    const first = feed.items[0];
    expect(first.title).toBe(
      "Bitcoin catches a bid after weekly loss, on track for best day in over a month",
    );
    expect(first.guid).toContain("investing.com");
    expect(first.publishedAt).toBe("2026-08-17T22:27:24.000Z");
  });

  it("attributes the original publisher via dc:creator and <source>", () => {
    const first = feed.items[0];
    expect(first.author).toBe("Investing.com");
    expect(first.sourceName).toBe("Cryptocurrency News");
  });

  it("picks up a media:thumbnail image", () => {
    expect(feed.items[0].imageUrl).toBe(
      "https://content-media.investing.com/news/moved_LYNXMPEKA01G9_L.jpg",
    );
  });
});

describe("parseFeed — Atom", () => {
  const atom = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Example Blog</title>
      <entry>
        <title>Hello &amp; welcome</title>
        <link rel="alternate" href="/posts/hello"/>
        <id>tag:example.com,2026:post-1</id>
        <published>2026-08-01T10:00:00Z</published>
        <author><name>Ada</name></author>
        <summary>&lt;p&gt;A short &lt;b&gt;intro&lt;/b&gt;.&lt;/p&gt;</summary>
      </entry>
    </feed>`;

  const feed = parseFeed(atom, "https://example.com/feed.xml");

  it("resolves relative entry links against the feed URL", () => {
    expect(feed.items[0].url).toBe("https://example.com/posts/hello");
  });

  it("decodes entities in titles", () => {
    expect(feed.items[0].title).toBe("Hello & welcome");
  });

  it("strips markup out of the summary", () => {
    expect(feed.items[0].summary).toBe("A short intro .");
  });

  it("reads the atom author name and id", () => {
    expect(feed.items[0].author).toBe("Ada");
    expect(feed.items[0].guid).toBe("tag:example.com,2026:post-1");
  });
});

describe("parseFeed — hostile input", () => {
  it("returns no items for a non-feed document rather than throwing", () => {
    expect(parseFeed("<html><body>not a feed</body></html>", "https://a.com").items).toEqual(
      [],
    );
  });

  it("returns no items for empty input", () => {
    expect(parseFeed("", "https://a.com").items).toEqual([]);
  });

  it("skips entries whose link is unusable", () => {
    const xml = `<rss><channel>
      <item><title>No link</title></item>
      <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
      <item><title>Good</title><link>https://ok.example/post</link></item>
    </channel></rss>`;
    const items = parseFeed(xml, "https://a.com").items;
    expect(items.map((i) => i.url)).toEqual(["https://ok.example/post"]);
  });

  it("honours the item cap", () => {
    const items = Array.from(
      { length: 30 },
      (_, i) => `<item><link>https://e.com/${i}</link></item>`,
    ).join("");
    expect(parseFeed(`<rss><channel>${items}</channel></rss>`, "https://a.com", 10).items.length).toBe(
      10,
    );
  });
});

describe("summarize", () => {
  it("returns null for empty prose", () => {
    expect(summarize(null)).toBeNull();
    expect(summarize("   ")).toBeNull();
  });

  it("drops script and style bodies", () => {
    expect(summarize("<style>p{color:red}</style>Real text<script>evil()</script>")).toBe(
      "Real text",
    );
  });

  it("truncates long prose on a word boundary", () => {
    const long = "word ".repeat(400);
    const out = summarize(long)!;
    expect(out.length).toBeLessThanOrEqual(601);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
});
