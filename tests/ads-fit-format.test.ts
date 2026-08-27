import { describe, expect, it } from "vitest";
import { fitAdFormat, PUBLISHER_FORMAT_IDS } from "@/lib/ads/formats";

const ALL = PUBLISHER_FORMAT_IDS;

describe("fitAdFormat", () => {
  it("keeps a format that fits", () => {
    expect(fitAdFormat("banner_728x90", 800, ALL)).toBe("banner_728x90");
    expect(fitAdFormat("banner_300x250", 300, ALL)).toBe("banner_300x250");
  });

  it("downgrades a leaderboard that cannot fit a phone column", () => {
    // The failure this exists for: 6,836 mobile leaderboard impressions, one
    // click, because the CTA sat past the right edge of a clipped iframe.
    expect(fitAdFormat("banner_728x90", 390, ALL)).toBe("banner_300x250");
  });

  it("prefers the rectangle over the mobile strip when both fit", () => {
    // Both fit at 390px (300 and 320 wide). The rectangle converts ~7x better,
    // so the choice is by area, not by width.
    expect(fitAdFormat("banner_728x90", 390, ALL)).toBe("banner_300x250");
    expect(fitAdFormat("banner_728x90", 325, ALL)).toBe("banner_300x250");
  });

  it("falls back to the narrowest offered unit when nothing fits", () => {
    // A clipped ad still beats a blank slot.
    expect(fitAdFormat("banner_728x90", 200, ALL)).toBe("banner_300x250");
  });

  it("never leaves the slot's own format list", () => {
    // Downgrading to a format the slot does not offer would be refused later
    // and return no fill at all.
    const only = ["banner_728x90", "banner_320x50"];
    expect(fitAdFormat("banner_728x90", 390, only)).toBe("banner_320x50");
  });

  it("refuses a format the slot does not offer, as before", () => {
    expect(fitAdFormat("banner_728x90", 800, ["banner_300x250"])).toBeNull();
  });

  it("leaves full-width and boxless formats alone", () => {
    // A text link fills whatever it is given; the terminal and feed units have
    // no pixel box at all.
    expect(fitAdFormat("text_link", 320, null)).toBe("text_link");
    expect(fitAdFormat("terminal_ascii", 100, null)).toBe("terminal_ascii");
    expect(fitAdFormat("feed_item", 100, null)).toBe("feed_item");
  });

  it("honours the request when no width was measured", () => {
    // Older tags, and the MOTD/feed endpoints, send no width — there is no
    // basis to second-guess the publisher.
    for (const w of [null, undefined, 0, NaN]) {
      expect(fitAdFormat("banner_728x90", w, ALL)).toBe("banner_728x90");
    }
  });
});
