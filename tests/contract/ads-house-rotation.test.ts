import { describe, expect, it } from "vitest";
import { houseFill } from "@/lib/ads/house";
import { TERMINAL_FORMAT_ID } from "@/lib/ads/formats";
import type { AdFormatId } from "@/lib/ads/creative";

// Until a slot sells, every fill on it is a house ad. A single hard-coded
// house creative made those fills byte-identical, so an MOTD or SSH banner
// printed the same block on every login and read as frozen. These lock in the
// rotation, and the invariant that one fill speaks with one voice.

const FORMATS: AdFormatId[] = [
  "banner_300x250",
  "banner_728x90",
  "banner_320x50",
  "text_link",
  TERMINAL_FORMAT_ID,
];

// 200 draws makes a false failure vanishingly unlikely while still catching a
// pool that has collapsed back to one entry.
function headlinesOver(format: AdFormatId, draws = 200): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < draws; i++) seen.add(houseFill(format).creative.headline);
  return seen;
}

describe("house ad rotation", () => {
  it("serves more than one creative on repeat fills of the same format", () => {
    for (const format of FORMATS) {
      expect(headlinesOver(format).size).toBeGreaterThan(1);
    }
  });

  it("keeps a single fill internally consistent across creative, html and text", () => {
    // The copy is drawn once per fill and threaded through. Drawing separately
    // per render would let one impression pitch two different things.
    for (const format of FORMATS) {
      for (let i = 0; i < 100; i++) {
        const fill = houseFill(format);
        const headline = fill.creative.headline;
        const escaped = headline
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        expect(fill.html).toContain(escaped);
        expect(fill.text).toContain(headline);
      }
    }
  });

  it("tags non-terminal click urls with the variant, and leaves terminal urls short", () => {
    for (let i = 0; i < 50; i++) {
      // The terminal URL is printed as literal text inside the ASCII box, so it
      // carries no utm_content — there is no width to spare.
      expect(houseFill(TERMINAL_FORMAT_ID).clickUrl).not.toContain("utm_content");
      expect(houseFill("banner_300x250").clickUrl).toMatch(/utm_content=[a-z0-9-]+$/);
    }
  });

  it("stays house-tier and unmetered however the copy rotates", () => {
    for (const format of FORMATS) {
      const fill = houseFill(format);
      expect(fill.campaignId).toBe("house");
      expect(fill.creativeId).toBe("house");
    }
  });
});
