import { describe, expect, it } from "vitest";
import { isDeadExternalUrl, stripDeadLinks } from "@/lib/dead-links";

describe("stripDeadLinks", () => {
  it("unwraps dead anchors and keeps the text", () => {
    const html = '<p>See <a href="https://c0upons.com/blog/walgreens-coupon-code-workflow">this</a>.</p>';
    expect(stripDeadLinks(html)).toBe("<p>See this.</p>");
  });
  it("matches bare origins with or without a trailing slash", () => {
    expect(isDeadExternalUrl("https://www.googletagmanager.com/")).toBe(true);
    expect(isDeadExternalUrl("https://www.googletagmanager.com")).toBe(true);
  });
  it("drops placeholder hosts and email-protection links", () => {
    expect(isDeadExternalUrl("https://example.com/blog/post/")).toBe(true);
    expect(isDeadExternalUrl("https://x.org/cdn-cgi/l/email-protection#ab")).toBe(true);
  });
  it("leaves live links alone", () => {
    const html = '<a href="https://crawlproof.com/blog/x">x</a> <a href="https://crates.io/crates/serde">s</a>';
    expect(stripDeadLinks(html)).toBe(html);
  });
});
