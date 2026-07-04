import { describe, it, expect } from "vitest";
import { canonicalizeUrl, normalizeDomain, hostMatchesDomain } from "@/lib/alerts/dedupe";

describe("canonicalizeUrl", () => {
  it("treats http/https and www/non-www as identical", () => {
    const a = canonicalizeUrl("http://www.example.com/post");
    const b = canonicalizeUrl("https://example.com/post");
    expect(a).toBe(b);
  });

  it("strips tracking params, fragments, and trailing slashes", () => {
    expect(canonicalizeUrl("https://example.com/post/?utm_source=x&gclid=1#top")).toBe(
      "https://example.com/post",
    );
  });

  it("keeps meaningful query params but sorts them for stable keys", () => {
    expect(canonicalizeUrl("https://example.com/s?b=2&a=1")).toBe("https://example.com/s?a=1&b=2");
  });

  it("preserves the root path", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("dedupes the same article to one key regardless of tracking noise", () => {
    const seen = new Set<string>();
    seen.add(canonicalizeUrl("https://blog.example.com/x?utm_campaign=a"));
    expect(seen.has(canonicalizeUrl("http://www.blog.example.com/x/?ref=twitter#hn"))).toBe(true);
  });

  it("falls back to a lowercased trim for non-URLs", () => {
    expect(canonicalizeUrl("  NotAUrl  ")).toBe("notaurl");
  });
});

describe("normalizeDomain", () => {
  it("strips scheme, www, path and query", () => {
    expect(normalizeDomain("https://www.acme.com/pricing?x=1")).toBe("acme.com");
  });
});

describe("hostMatchesDomain", () => {
  it("matches the domain and its subdomains", () => {
    expect(hostMatchesDomain("acme.com", "acme.com")).toBe(true);
    expect(hostMatchesDomain("blog.acme.com", "acme.com")).toBe(true);
    expect(hostMatchesDomain("www.acme.com", "acme.com")).toBe(true);
  });
  it("does not match unrelated, superstring, or look-alike domains", () => {
    expect(hostMatchesDomain("notacme.com", "acme.com")).toBe(false);
    // "acme.com.evil.com" is a subdomain of evil.com, NOT of acme.com.
    expect(hostMatchesDomain("acme.com.evil.com", "acme.com")).toBe(false);
    expect(hostMatchesDomain("fooacme.com", "acme.com")).toBe(false);
  });
});
