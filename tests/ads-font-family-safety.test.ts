import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_STACK, safeFontFamily } from "@/lib/ads/creative";

describe("safeFontFamily", () => {
  it("keeps both stacks that actually ship", () => {
    // The only two values in production, across 2,978 creatives.
    expect(safeFontFamily("system-ui, -apple-system, Segoe UI, Roboto, sans-serif")).toBe(
      "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    );
    expect(safeFontFamily("system-ui, sans-serif")).toBe("system-ui, sans-serif");
  });

  it("refuses a value that could close the CSS rule it sits in", () => {
    // The whole point: this lands inside a <style> block, where esc() does
    // nothing useful — `}` is still a closing brace after HTML-escaping.
    expect(safeFontFamily("x} .cp-ad{background:red} y{")).toBe(DEFAULT_FONT_STACK);
    expect(safeFontFamily("serif;color:red")).toBe(DEFAULT_FONT_STACK);
  });

  it("refuses anything that could pull in a remote resource", () => {
    // CSS can exfiltrate through a URL even with scripts disabled.
    expect(safeFontFamily("serif} *{background:url(https://evil.test/x)}")).toBe(DEFAULT_FONT_STACK);
    expect(safeFontFamily("url(https://evil.test/x)")).toBe(DEFAULT_FONT_STACK);
  });

  it("refuses quotes, angle brackets and backslashes outright", () => {
    for (const bad of ['"Helvetica"', "'Helvetica'", "a<b", "a>b", "a\\b", "a/*x*/b"]) {
      expect(safeFontFamily(bad)).toBe(DEFAULT_FONT_STACK);
    }
  });

  it("falls back on empty, missing and over-long values", () => {
    expect(safeFontFamily("")).toBe(DEFAULT_FONT_STACK);
    expect(safeFontFamily("   ")).toBe(DEFAULT_FONT_STACK);
    expect(safeFontFamily(null)).toBe(DEFAULT_FONT_STACK);
    expect(safeFontFamily(undefined)).toBe(DEFAULT_FONT_STACK);
    // Long but otherwise legal: still refused, because nothing we ship is.
    expect(safeFontFamily("a".repeat(121))).toBe(DEFAULT_FONT_STACK);
  });

  it("trims rather than rejecting incidental whitespace", () => {
    expect(safeFontFamily("  Roboto, sans-serif  ")).toBe("Roboto, sans-serif");
  });
});
