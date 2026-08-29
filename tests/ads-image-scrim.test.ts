import { describe, expect, it } from "vitest";
import { imageScrim, overImageShadow, SCRIM_ALPHA, type AdCreative } from "@/lib/ads/formats";
import { renderCreativeHtml } from "@/lib/ads/creative";
import { renderHouseAdHtml } from "@/lib/ads/house";

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "banner_300x250",
    headline: "Ship it",
    body: "One benefit line",
    ctaText: "Try it",
    bgColor: "#0b0d10",
    fgColor: "#e7e9ee",
    accentColor: "#6ee7b7",
    lightBgColor: "#f7f9fc",
    lightFgColor: "#0b0d10",
    lightAccentColor: "#0f7a5a",
    fontFamily: "system-ui",
    logoUrl: null,
    imageUrl: "https://example.com/hero.png",
    ...over,
  } as AdCreative;
}

/** Every rgba() alpha in a gradient string, in order. */
function alphas(css: string): number[] {
  return [...css.matchAll(/rgba\([^)]*?,\s*([0-9.]+)\)/g)].map((m) => Number(m[1]));
}

describe("hero image scrim", () => {
  // The whole point of the change: it used to reach 0.86, which flattened the
  // bottom third of every rectangle into a block of ink and hid the artwork.
  it("never reaches opaque", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const axis of ["vertical", "horizontal"] as const) {
        for (const a of alphas(imageScrim(theme, axis))) {
          expect(a).toBeLessThanOrEqual(SCRIM_ALPHA);
        }
      }
    }
    expect(SCRIM_ALPHA).toBeLessThan(0.75);
  });

  it("is mixed from the theme's own ink, not the creative's background", () => {
    // Light fades the image towards white so dark copy can sit on it; dark
    // fades towards near-black. Reusing the palette background would leave the
    // headline on raw photo.
    expect(imageScrim("light")).toContain("rgba(255,255,255,");
    expect(imageScrim("dark")).toContain("rgba(7,10,16,");
  });

  it("runs its stops in one direction only", () => {
    // A stop that dips and rises again reads as a band across the artwork.
    for (const theme of ["dark", "light"] as const) {
      const vertical = alphas(imageScrim(theme, "vertical"));
      expect(vertical).toEqual([...vertical].sort((a, b) => a - b));
      const horizontal = alphas(imageScrim(theme, "horizontal"));
      expect(horizontal).toEqual([...horizontal].sort((a, b) => b - a));
    }
  });
});

describe("copy over a hero image", () => {
  // The scrim no longer supplies the contrast, so the glyphs carry their own.
  // The shadow is now declared once as a custom property and referenced at the
  // glyphs, so the invariant takes both halves: the right value, and something
  // actually reading it.
  it("gets a text shadow in the scrim's ink", () => {
    const html = renderCreativeHtml(creative(), "https://example.com/x", { theme: "dark" });
    expect(html).toContain(`--cp-shadow:${overImageShadow("dark")}`);
    expect(html).toContain("text-shadow:var(--cp-shadow)");
  });

  it("does not, when there is no image to sit on", () => {
    const html = renderCreativeHtml(creative({ imageUrl: null }), "https://example.com/x", {
      theme: "dark",
    });
    expect(html).not.toContain("text-shadow");
  });

  it("covers the house ad too", () => {
    for (const format of ["banner_300x250", "banner_728x90"] as const) {
      const html = renderHouseAdHtml(format, "https://example.com/x", undefined, "light");
      expect(html).toContain(`--cp-shadow:${overImageShadow("light")}`);
      expect(html).toContain("text-shadow:var(--cp-shadow)");
    }
  });
});

describe("overImageShadow", () => {
  it("stacks a tight edge and a soft halo", () => {
    // Two shadows: one for definition against busy detail, one to hold the few
    // pixels around each glyph where the image runs bright.
    expect(overImageShadow("dark").split("), ")).toHaveLength(2);
  });
});
