import { describe, it, expect } from "vitest";
import {
  normalizeInputUrl,
  extractFeedLinkFromHtml,
  extractBlogLinkFromHtml,
  looksLikeBlogUrl,
  parseFeed,
  extractPageExcerpt,
} from "@/lib/lx/detectBlog";

describe("normalizeInputUrl", () => {
  it("accepts a bare host", () => {
    const r = normalizeInputUrl("example.com");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://example.com/");
      expect(r.domain).toBe("example.com");
      expect(r.origin).toBe("https://example.com");
    }
  });
  it("strips www. from the domain", () => {
    const r = normalizeInputUrl("https://www.example.com/blog");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.domain).toBe("example.com");
  });
  it("drops the fragment", () => {
    const r = normalizeInputUrl("https://example.com/blog#section");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).not.toContain("#");
  });
  it("rejects garbage", () => {
    expect(normalizeInputUrl("").ok).toBe(false);
    expect(normalizeInputUrl("not a url").ok).toBe(false);
  });
  it("rejects non-http(s)", () => {
    const r = normalizeInputUrl("ftp://example.com");
    expect(r.ok).toBe(false);
  });
});

describe("extractFeedLinkFromHtml", () => {
  it("finds an RSS link in <head>", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed.xml">
    </head><body></body></html>`;
    expect(extractFeedLinkFromHtml(html, "https://example.com")).toBe(
      "https://example.com/feed.xml",
    );
  });
  it("finds an Atom link", () => {
    const html = `<head><link rel="alternate" type="application/atom+xml" href="https://example.com/atom"></head>`;
    expect(extractFeedLinkFromHtml(html, "https://example.com")).toBe(
      "https://example.com/atom",
    );
  });
  it("returns null when there's only an HTML alternate (not a feed)", () => {
    const html = `<link rel="alternate" hreflang="es" href="/es">`;
    expect(extractFeedLinkFromHtml(html, "https://example.com")).toBeNull();
  });
  it("returns null on an empty page", () => {
    expect(extractFeedLinkFromHtml("", "https://example.com")).toBeNull();
  });
});

describe("extractBlogLinkFromHtml", () => {
  it("picks the nav anchor whose text says blog", () => {
    const html = `
      <nav>
        <a href="/about">About</a>
        <a href="/blog">Our Blog</a>
        <a href="/contact">Contact</a>
      </nav>`;
    expect(extractBlogLinkFromHtml(html, "https://example.com")).toBe(
      "https://example.com/blog",
    );
  });
  it("picks an anchor by href even if the text doesn't say blog", () => {
    const html = `<a href="/blog/">Read</a>`;
    expect(extractBlogLinkFromHtml(html, "https://example.com")).toBe(
      "https://example.com/blog/",
    );
  });
  it("rejects cross-origin matches", () => {
    const html = `<a href="https://other.com/blog">Friend's Blog</a>`;
    expect(extractBlogLinkFromHtml(html, "https://example.com")).toBeNull();
  });
  it("returns null when nothing matches", () => {
    const html = `<a href="/about">About us</a>`;
    expect(extractBlogLinkFromHtml(html, "https://example.com")).toBeNull();
  });
});

describe("looksLikeBlogUrl", () => {
  it("flags /blog/ URLs", () => {
    expect(looksLikeBlogUrl("https://example.com/blog")).toBe(true);
    expect(looksLikeBlogUrl("https://example.com/blog/")).toBe(true);
    expect(looksLikeBlogUrl("https://example.com/blog/post-x")).toBe(true);
  });
  it("doesn't flag the homepage", () => {
    expect(looksLikeBlogUrl("https://example.com/")).toBe(false);
    expect(looksLikeBlogUrl("https://example.com/about")).toBe(false);
  });
  it("doesn't false-positive on /blog-archive", () => {
    expect(looksLikeBlogUrl("https://example.com/blog-archive")).toBe(false);
  });
});

describe("parseFeed — RSS 2.0", () => {
  const rss = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Crawlproof Blog</title>
      <description>Auditing AI bot access since 2026.</description>
      <item>
        <title>How GPTBot reads your site</title>
        <description>A breakdown of what the bot does in production logs.</description>
        <category>seo</category>
        <category>ai bots</category>
      </item>
      <item>
        <title>Why your llms.txt matters</title>
        <description>The plain-text manifest you should ship.</description>
      </item>
    </channel></rss>`;
  it("pulls channel title + description", () => {
    const f = parseFeed(rss);
    expect(f.title).toBe("Crawlproof Blog");
    expect(f.description).toContain("Auditing AI bot access");
  });
  it("pulls items with categories", () => {
    const f = parseFeed(rss);
    expect(f.items).toHaveLength(2);
    expect(f.items[0].title).toBe("How GPTBot reads your site");
    expect(f.items[0].categories).toEqual(["seo", "ai bots"]);
    expect(f.items[1].title).toBe("Why your llms.txt matters");
  });
});

describe("parseFeed — Atom", () => {
  const atom = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Crawlproof</title>
      <subtitle>SEO + AEO notes</subtitle>
      <entry>
        <title>Atom test post</title>
        <summary>This is the summary.</summary>
        <category term="aeo"/>
      </entry>
    </feed>`;
  it("pulls feed title + subtitle", () => {
    const f = parseFeed(atom);
    expect(f.title).toBe("Crawlproof");
    expect(f.description).toBe("SEO + AEO notes");
  });
  it("pulls entries with category term", () => {
    const f = parseFeed(atom);
    expect(f.items).toHaveLength(1);
    expect(f.items[0].title).toBe("Atom test post");
    expect(f.items[0].categories).toEqual(["aeo"]);
  });
});

describe("parseFeed — robustness", () => {
  it("returns empty struct on garbage", () => {
    const f = parseFeed("not xml");
    expect(f.title).toBeNull();
    expect(f.items).toEqual([]);
  });
});

describe("extractPageExcerpt", () => {
  it("prefers og:title and parses meta description", () => {
    const html = `<head>
      <title>Plain</title>
      <meta property="og:title" content="OG Title">
      <meta name="description" content="Short description.">
      <meta property="og:site_name" content="ExampleCo">
    </head>
    <body><h1>Hero text</h1><p>Body paragraph.</p></body>`;
    const r = extractPageExcerpt(html);
    expect(r.title).toBe("OG Title");
    expect(r.siteName).toBe("ExampleCo");
    expect(r.description).toBe("Short description.");
    expect(r.h1).toBe("Hero text");
    expect(r.body).toContain("Body paragraph.");
  });
  it("strips nav/footer from body", () => {
    const html = `<body>
      <nav><a>Home</a><a>About</a></nav>
      <main><p>Real content here.</p></main>
      <footer><p>© 2026</p></footer>
    </body>`;
    const r = extractPageExcerpt(html);
    expect(r.body).toContain("Real content here.");
    expect(r.body).not.toContain("© 2026");
    expect(r.body).not.toContain("Home");
  });
});
