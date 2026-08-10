import { describe, expect, it } from "vitest";
import { isAllowedTargetUrl } from "@/lib/rateLimit";

// CONTROL_OR_WS used to be written with raw control bytes embedded directly in
// the regex literal, which made the whole file read as binary to grep and other
// tooling (searches for anything in lib/rateLimit.ts silently returned nothing).
// It is now spelled with \u escapes. These tests pin the behaviour so the
// rewrite is provably equivalent rather than merely plausible.
describe("isAllowedTargetUrl control-character handling", () => {
  // Built with String.fromCharCode so this source file stays plain ASCII —
  // embedding the raw bytes is what made lib/rateLimit.ts unsearchable.
  const CONTROL_CASES: Array<[string, string]> = [
    ["NUL", String.fromCharCode(0)],
    ["TAB", String.fromCharCode(9)],
    ["LF", String.fromCharCode(10)],
    ["CR", String.fromCharCode(13)],
    ["unit separator", String.fromCharCode(31)],
    ["DEL", String.fromCharCode(127)],
    ["space", " "],
  ];

  for (const [name, ch] of CONTROL_CASES) {
    it(`rejects a URL containing ${name}`, () => {
      const result = isAllowedTargetUrl(`https://example.com/a${ch}b`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/control characters or whitespace/);
      }
    });
  }

  it("still accepts an ordinary URL", () => {
    const result = isAllowedTargetUrl("https://example.com/path?a=1");
    expect(result.ok).toBe(true);
  });

  it("still accepts URL punctuation adjacent to the rejected range", () => {
    // '!' (0x21) sits just above the control range; nothing in normal URL
    // syntax should have been caught by the widened escape form.
    const result = isAllowedTargetUrl("https://example.com/a!b~c$d");
    expect(result.ok).toBe(true);
  });

  it("trims surrounding whitespace rather than rejecting it", () => {
    const result = isAllowedTargetUrl("  https://example.com/ok  ");
    expect(result.ok).toBe(true);
  });
});
