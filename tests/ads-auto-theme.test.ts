// The 'auto' rendering mode: one document, both palettes, the reader's own
// browser deciding.
//
// This exists for /api/ads/frame, the script-free embed. That path cannot read
// the publisher's background the way /ad.js does — there is no script on the
// page to read it with — so before this it rendered whatever the slot said, and
// a slot that said nothing rendered dark. A light publisher got a black bar
// punched into their page, which is the exact failure theme variants were added
// to prevent.

import { describe, expect, it } from "vitest";
import { renderCreativeHtml } from "@/lib/ads/creative";
import { renderHouseAdHtml } from "@/lib/ads/house";
import { resolveTheme, resolveThemePref } from "@/lib/ads/serve";
import { paletteFor, type AdCreative } from "@/lib/ads/formats";
import { AD_THEMES } from "@/lib/ads/theme";

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "text_link",
    headline: "Ship it",
    body: "One benefit line",
    ctaText: "Try it",
    bgColor: "#0b0d10",
    fgColor: "#e7e9ee",
    accentColor: "#6ee7b7",
    fontFamily: "system-ui, sans-serif",
    logoUrl: null,
    imageUrl: null,
    ...over,
  };
}

const MEDIA_QUERY = "@media (prefers-color-scheme:dark)";

describe("resolveThemePref", () => {
  it("lets an explicit request win from either side", () => {
    expect(resolveThemePref("light", "dark")).toBe("light");
    expect(resolveThemePref("dark", "light")).toBe("dark");
    expect(resolveThemePref(null, "light")).toBe("light");
  });

  it("answers auto only when nobody looked", () => {
    expect(resolveThemePref("auto", null)).toBe("auto");
    expect(resolveThemePref(null, "auto")).toBe("auto");
    expect(resolveThemePref("auto", "auto")).toBe("auto");
  });

  it("still lets a publisher pin a slot against an auto request", () => {
    // The frame embed asks for auto by default. A publisher who has set their
    // slot has looked at their own page, and that beats a media query.
    expect(resolveThemePref("auto", "light")).toBe("light");
  });

  it("falls back to dark, which is what a creative rendered as before", () => {
    expect(resolveThemePref(null, null)).toBe("dark");
    expect(resolveThemePref("nonsense", undefined)).toBe("dark");
  });

  it("collapses to a concrete theme for surfaces with no CSS", () => {
    // A MOTD over curl and a feed body in somebody's reader cannot honour a
    // media query, so resolveTheme keeps answering light or dark.
    expect(resolveTheme("auto", null)).toBe("dark");
    expect(AD_THEMES).toContain(resolveTheme("auto", "auto"));
  });
});

describe("auto rendering", () => {
  it("ships both palettes, light as the base", () => {
    const c = creative();
    const html = renderCreativeHtml(c, "https://example.com", { theme: "auto" });
    const light = paletteFor(c, "light");
    const dark = paletteFor(c, "dark");

    const cut = html.indexOf(MEDIA_QUERY);
    expect(cut).toBeGreaterThan(-1);

    // Light is the base for the same reason ad.js composites over white: a page
    // with no styling of its own is white, whatever the OS prefers.
    expect(html.slice(0, cut)).toContain(`--cp-bg:${light.bgColor}`);
    expect(html.slice(cut)).toContain(`--cp-bg:${dark.bgColor}`);
  });

  it("declares color-scheme so the frame's own canvas follows", () => {
    const html = renderCreativeHtml(creative(), "https://example.com", { theme: "auto" });
    expect(html).toContain("color-scheme:light dark");
  });

  it("emits no media query when a theme was actually chosen", () => {
    for (const theme of AD_THEMES) {
      const html = renderCreativeHtml(creative(), "https://example.com", { theme });
      expect(html, theme).not.toContain(MEDIA_QUERY);
      expect(html, theme).not.toContain("color-scheme");
    }
  });

  it("covers the banner formats, where the scrim and the wash move too", () => {
    const c = creative({ format: "banner_300x250", imageUrl: "https://example.com/hero.webp" });
    const html = renderCreativeHtml(c, "https://example.com", { theme: "auto" });
    const cut = html.indexOf(MEDIA_QUERY);

    // The scrim is mixed from the ink side, so it has to flip with the palette
    // or a light unit gets a dark gradient over pale artwork.
    for (const half of [html.slice(0, cut), html.slice(cut)]) {
      expect(half).toContain("--cp-scrim:");
      expect(half).toContain("--cp-overInk:");
      expect(half).toContain("--cp-edge:");
    }
    expect(html.slice(0, cut)).not.toEqual(html.slice(cut));
  });

  it("covers the house ad, which is what an unsold slot shows", () => {
    for (const format of ["text_link", "banner_300x250", "banner_728x90"] as const) {
      const html = renderHouseAdHtml(format, "https://example.com", undefined, "auto");
      expect(html, format).toContain(MEDIA_QUERY);
    }
  });

  it("leaves no raw colour behind at a use site", () => {
    // Every theme-dependent value has to go through a variable, or half the
    // document would keep the base palette when the media query fires. The
    // check is deliberately on the markup after the style block.
    const formats = ["text_link", "banner_300x250", "banner_728x90", "banner_320x50"] as const;
    for (const format of formats) {
      for (const imageUrl of [null, "https://example.com/hero.webp"]) {
        const html = renderCreativeHtml(creative({ format, imageUrl }), "https://example.com", {
          theme: "auto",
        });
        const body = html.slice(html.indexOf("</style>"));
        expect(body, `${format} image=${Boolean(imageUrl)}`).not.toMatch(/#[0-9a-fA-F]{6}/);
        expect(body, `${format} image=${Boolean(imageUrl)}`).not.toMatch(/rgba?\(/);
      }
    }
  });
});
