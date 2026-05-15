import { describe, it, expect } from "vitest";
import { extractLocs, isSitemapIndex, isBlogPost, extractMeta } from "@/lib/lx/sitemapCrawl";

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
