import { describe, it, expect } from "vitest";
import {
  canonicalizeUrl,
  normalizeUrlForIdentity,
  normalizedTitleHash,
  isTrackingParam,
  urlHash,
} from "@/lib/promote/normalizeUrl";

describe("canonicalizeUrl — the form we publish", () => {
  it("strips utm_* campaign tags", () => {
    expect(
      canonicalizeUrl("https://example.com/post?utm_source=x&utm_medium=social"),
    ).toBe("https://example.com/post");
  });

  it("strips network click ids", () => {
    expect(canonicalizeUrl("https://example.com/p?fbclid=abc&gclid=def&igshid=g")).toBe(
      "https://example.com/p",
    );
  });

  it("keeps parameters that select the resource", () => {
    expect(canonicalizeUrl("https://example.com/search?q=bitcoin&page=2&utm_source=x")).toBe(
      "https://example.com/search?q=bitcoin&page=2",
    );
  });

  it("keeps a bare ref, which routes on some sites", () => {
    // CrawlProof's own short links carry ref_slug; dropping ref-ish params
    // wholesale risks publishing a link that no longer resolves.
    expect(canonicalizeUrl("https://example.com/p?ref=producthunt")).toBe(
      "https://example.com/p?ref=producthunt",
    );
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://example.com/post#section-2")).toBe(
      "https://example.com/post",
    );
  });

  it("preserves host case sensitivity of the path and the www prefix", () => {
    expect(canonicalizeUrl("https://www.example.com/Post/Title")).toBe(
      "https://www.example.com/Post/Title",
    );
  });

  it("rejects anything that is not a web link", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("ftp://example.com/f")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("")).toBeNull();
  });
});

describe("normalizeUrlForIdentity — the form we dedupe on", () => {
  it("folds http and https to one identity", () => {
    expect(normalizeUrlForIdentity("http://example.com/p")).toBe(
      normalizeUrlForIdentity("https://example.com/p"),
    );
  });

  it("folds the www prefix away", () => {
    expect(normalizeUrlForIdentity("https://www.example.com/p")).toBe(
      normalizeUrlForIdentity("https://example.com/p"),
    );
  });

  it("folds a trailing slash away", () => {
    expect(normalizeUrlForIdentity("https://example.com/p/")).toBe(
      normalizeUrlForIdentity("https://example.com/p"),
    );
  });

  it("does not fold the root path away", () => {
    expect(normalizeUrlForIdentity("https://example.com/")).toBe("https://example.com/");
  });

  it("treats reordered query parameters as the same resource", () => {
    expect(normalizeUrlForIdentity("https://e.com/s?b=2&a=1")).toBe(
      normalizeUrlForIdentity("https://e.com/s?a=1&b=2"),
    );
  });

  it("keeps genuinely different resources apart", () => {
    expect(normalizeUrlForIdentity("https://e.com/a")).not.toBe(
      normalizeUrlForIdentity("https://e.com/b"),
    );
    expect(normalizeUrlForIdentity("https://e.com/s?page=1")).not.toBe(
      normalizeUrlForIdentity("https://e.com/s?page=2"),
    );
  });

  it("is case-insensitive on the host but not the path", () => {
    expect(normalizeUrlForIdentity("https://EXAMPLE.com/Post")).toBe(
      "https://example.com/Post",
    );
  });
});

describe("urlHash", () => {
  it("agrees for URLs that differ only in tracking and shape", () => {
    expect(urlHash("http://www.example.com/p/?utm_source=x")).toBe(
      urlHash("https://example.com/p"),
    );
  });

  it("is a sha256 hex digest", () => {
    expect(urlHash("https://example.com/p")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns null rather than hashing garbage", () => {
    expect(urlHash("not a url")).toBeNull();
  });
});

describe("normalizedTitleHash", () => {
  it("ignores dash style and case, so the same story matches", () => {
    expect(normalizedTitleHash("Foo — Bar")).toBe(normalizedTitleHash("foo - bar"));
  });

  it("separates genuinely different headlines", () => {
    expect(normalizedTitleHash("Bitcoin rises")).not.toBe(
      normalizedTitleHash("Bitcoin falls"),
    );
  });

  it("returns null for an empty title", () => {
    expect(normalizedTitleHash("")).toBeNull();
    expect(normalizedTitleHash(null)).toBeNull();
  });
});

describe("isTrackingParam", () => {
  it("matches whole analytics families by prefix", () => {
    expect(isTrackingParam("utm_content")).toBe(true);
    expect(isTrackingParam("mtm_campaign")).toBe(true);
    expect(isTrackingParam("_hsenc")).toBe(true);
  });

  it("leaves content parameters alone", () => {
    expect(isTrackingParam("q")).toBe(false);
    expect(isTrackingParam("page")).toBe(false);
    expect(isTrackingParam("id")).toBe(false);
  });
});
