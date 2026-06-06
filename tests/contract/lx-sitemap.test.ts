import { describe, it, expect } from "vitest";
import {
  extractLocs,
  extractSitemapEntries,
  extractUrlEntries,
  sortByRecency,
  isSitemapIndex,
  isBlogPost,
  extractMeta,
} from "@/lib/lx/sitemapCrawl";

describe("extractLocs", () => {
  it("pulls all <loc> values from a urlset", () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
      </urlset>`;
    expect(extractLocs(xml)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("works for sitemapindex shape too", () => {
    const xml = `<sitemapindex>
        <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
      </sitemapindex>`;
    expect(extractLocs(xml)).toEqual([
      "https://example.com/sitemap-1.xml",
      "https://example.com/sitemap-2.xml",
    ]);
  });

  it("tolerates whitespace inside the tag", () => {
    const xml = "<loc>\n  https://example.com/a  \n</loc>";
    expect(extractLocs(xml)).toEqual(["https://example.com/a"]);
  });

  it("returns [] on garbage input", () => {
    expect(extractLocs("not xml at all")).toEqual([]);
  });
});

describe("extractSitemapEntries", () => {
  it("extracts loc and lastmod from each <sitemap> block", () => {
    const xml = `<sitemapindex>
      <sitemap><loc>https://example.com/s1.xml</loc><lastmod>2026-03-01</lastmod></sitemap>
      <sitemap><loc>https://example.com/s2.xml</loc></sitemap>
    </sitemapindex>`;
    expect(extractSitemapEntries(xml)).toEqual([
      { loc: "https://example.com/s1.xml", lastmod: "2026-03-01" },
      { loc: "https://example.com/s2.xml", lastmod: null },
    ]);
  });

  it("handles multiline <loc> (bittorrented.com pattern)", () => {
    const xml = `<sitemapindex>
<sitemap>
<loc>
https://bittorrented.com/sitemaps/torrents-2026-01.xml
</loc>
</sitemap>
<sitemap>
</sitemap>
<sitemap>
<loc>
https://bittorrented.com/sitemaps/torrents-2026-06.xml
</loc>
</sitemap>
</sitemapindex>`;
    expect(extractSitemapEntries(xml)).toEqual([
      { loc: "https://bittorrented.com/sitemaps/torrents-2026-01.xml", lastmod: null },
      { loc: "https://bittorrented.com/sitemaps/torrents-2026-06.xml", lastmod: null },
    ]);
  });
});

describe("extractUrlEntries", () => {
  it("extracts loc and lastmod from each <url> block", () => {
    const xml = `<urlset>
      <url><loc>https://example.com/a</loc><lastmod>2026-01-15</lastmod></url>
      <url><loc>https://example.com/b</loc></url>
    </urlset>`;
    expect(extractUrlEntries(xml)).toEqual([
      { loc: "https://example.com/a", lastmod: "2026-01-15" },
      { loc: "https://example.com/b", lastmod: null },
    ]);
  });

  it("handles multiline <loc> inside <url>", () => {
    const xml = `<urlset>
<url>
<loc>
https://example.com/page-1
</loc>
<lastmod>2026-06-01</lastmod>
</url>
</urlset>`;
    expect(extractUrlEntries(xml)).toEqual([
      { loc: "https://example.com/page-1", lastmod: "2026-06-01" },
    ]);
  });
});

describe("sortByRecency", () => {
  it("sorts by lastmod desc when present", () => {
    const entries = [
      { loc: "a", lastmod: "2026-01-01" },
      { loc: "b", lastmod: "2026-06-01" },
      { loc: "c", lastmod: "2026-03-01" },
    ];
    expect(sortByRecency(entries).map((e) => e.loc)).toEqual(["b", "c", "a"]);
  });

  it("reverses document order when no lastmod (newer appended last)", () => {
    const entries = [
      { loc: "2026-01", lastmod: null },
      { loc: "2026-04", lastmod: null },
      { loc: "2026-06", lastmod: null },
    ];
    expect(sortByRecency(entries).map((e) => e.loc)).toEqual(["2026-06", "2026-04", "2026-01"]);
  });

  it("treats missing lastmod as oldest when mixed", () => {
    const entries = [
      { loc: "a", lastmod: null },
      { loc: "b", lastmod: "2026-06-01" },
    ];
    expect(sortByRecency(entries).map((e) => e.loc)).toEqual(["b", "a"]);
  });
});

describe("isSitemapIndex", () => {
  it("detects sitemapindex shape", () => {
    expect(isSitemapIndex("<sitemapindex><sitemap></sitemap></sitemapindex>")).toBe(true);
  });
  it("returns false for plain urlset", () => {
    expect(isSitemapIndex("<urlset><url></url></urlset>")).toBe(false);
  });
});

describe("isBlogPost", () => {
  const blogRoot = "https://example.com/blog";

  it("matches a post under /blog/", () => {
    expect(isBlogPost("https://example.com/blog/my-post", blogRoot)).toBe(true);
  });
  it("rejects the blog root itself", () => {
    expect(isBlogPost("https://example.com/blog", blogRoot)).toBe(false);
    expect(isBlogPost("https://example.com/blog/", blogRoot)).toBe(false);
  });
  it("rejects pages outside the blog root", () => {
    expect(isBlogPost("https://example.com/about", blogRoot)).toBe(false);
  });
  it("rejects matching path on different host", () => {
    expect(isBlogPost("https://other.com/blog/post", blogRoot)).toBe(false);
  });
  it("does not match /blog-archive as if it were under /blog", () => {
    expect(isBlogPost("https://example.com/blog-archive/post", blogRoot)).toBe(false);
  });
});

describe("extractMeta", () => {
  it("prefers og:title over <title>", () => {
    const html = `
      <head>
        <title>Plain title</title>
        <meta property="og:title" content="OG title">
      </head>`;
    expect(extractMeta(html).title).toBe("OG title");
  });
  it("falls back to <title>", () => {
    const html = "<head><title>Just a title</title></head>";
    expect(extractMeta(html).title).toBe("Just a title");
  });
  it("decodes basic HTML entities", () => {
    const html = `<head><title>Foo &amp; Bar &#39;baz&#39;</title></head>`;
    expect(extractMeta(html).title).toBe("Foo & Bar 'baz'");
  });
  it("returns null fields when nothing is present", () => {
    expect(extractMeta("<html><body></body></html>")).toEqual({
      title: null,
      description: null,
    });
  });
  it("extracts meta description", () => {
    const html = `<head><meta name="description" content="A clear summary."></head>`;
    expect(extractMeta(html).description).toBe("A clear summary.");
  });
});
