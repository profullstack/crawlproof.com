import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  derivePalette,
  hairline,
  luminance,
  parseColor,
  solid,
  themeOfBackground,
  toHex,
  type AdPalette,
} from "@/lib/ads/theme";
import { hexToRgba, paletteFor, type AdCreative } from "@/lib/ads/formats";
import { renderCreativeHtml } from "@/lib/ads/creative";
import { resolveTheme } from "@/lib/ads/serve";
import { renderHouseAdHtml } from "@/lib/ads/house";

const DARK: AdPalette = { bgColor: "#0b0d10", fgColor: "#e7e9ee", accentColor: "#6ee7b7" };

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "text_link",
    headline: "Ship it",
    body: "One benefit line",
    ctaText: "Try it",
    ...DARK,
    fontFamily: "system-ui, sans-serif",
    logoUrl: null,
    imageUrl: null,
    ...over,
  };
}

describe("colour parsing", () => {
  it("reads 3, 4, 6 and 8 digit hex", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0b0d10")).toEqual({ r: 11, g: 13, b: 16, a: 1 });
    expect(parseColor("#00000080")?.a).toBeCloseTo(0.502, 2);
    expect(parseColor("not a colour")).toBeNull();
  });

  it("round-trips through hex, keeping alpha only when it is not opaque", () => {
    expect(toHex({ r: 11, g: 13, b: 16, a: 1 })).toBe("#0b0d10");
    expect(toHex({ r: 11, g: 13, b: 16, a: 0.5 })).toBe("#0b0d1080");
  });

  it("strips alpha for inks that punch out of a chip", () => {
    expect(solid("#0b0d1080")).toBe("#0b0d10");
    expect(solid("#0b0d10")).toBe("#0b0d10");
  });

  it("flattens a translucent colour over white when judging polarity", () => {
    // 20%-opacity black over white is a light grey, not a dark colour — this is
    // what a viewer actually sees on a page with no background of its own.
    expect(themeOfBackground("#00000033")).toBe("light");
    expect(themeOfBackground("#000000")).toBe("dark");
  });

  it("multiplies alpha rather than replacing it", () => {
    // A half-transparent brand colour asked for at 50% is 25%, not 50%.
    expect(hexToRgba("#ffffff80", 0.5)).toBe("rgba(255,255,255,0.251)");
    expect(hexToRgba("#ffffff", 0.5)).toBe("rgba(255,255,255,0.5)");
  });
});

describe("derivePalette", () => {
  it("produces a readable light counterpart from a dark palette", () => {
    const light = derivePalette(DARK, "light");
    expect(themeOfBackground(light.bgColor)).toBe("light");
    expect(contrastRatio(light.fgColor, light.bgColor)).toBeGreaterThanOrEqual(4.5);
    // 3:1 is the WCAG bar for a UI component, which is what the CTA chip is.
    expect(contrastRatio(light.accentColor, light.bgColor)).toBeGreaterThanOrEqual(3);
  });

  it("produces a readable dark counterpart from a light palette", () => {
    const source: AdPalette = { bgColor: "#ffffff", fgColor: "#111111", accentColor: "#0a7d55" };
    const dark = derivePalette(source, "dark");
    expect(themeOfBackground(dark.bgColor)).toBe("dark");
    expect(contrastRatio(dark.fgColor, dark.bgColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accentColor, dark.bgColor)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the brand hue rather than inventing a new colour", () => {
    // A neon mint accent must still be a green on the light variant.
    const light = derivePalette(DARK, "light");
    const c = parseColor(light.accentColor)!;
    expect(c.g).toBeGreaterThan(c.r);
    expect(c.g).toBeGreaterThan(c.b);
  });

  it("keeps a neutral accent neutral instead of inventing a hue", () => {
    // A grey has an arbitrary hue of 0. Flooring its saturation would turn the
    // advertiser's grey CTA red — this happened to a real creative (#a3a3a3).
    const light = derivePalette(
      { bgColor: "#0b0d10", fgColor: "#ffffff", accentColor: "#a3a3a3" },
      "light",
    );
    const c = parseColor(light.accentColor)!;
    const spread = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    expect(spread).toBeLessThanOrEqual(8);
    expect(contrastRatio(light.accentColor, light.bgColor)).toBeGreaterThanOrEqual(3);
  });

  it("stays readable across a spread of real-world brand colours", () => {
    const brands = ["#0b0d10", "#1a1a2e", "#101820", "#2d1b4e", "#0f172a", "#111111", "#003049"];
    for (const bg of brands) {
      for (const target of ["light", "dark"] as const) {
        const p = derivePalette({ bgColor: bg, fgColor: "#e7e9ee", accentColor: "#6ee7b7" }, target);
        expect(themeOfBackground(p.bgColor), `${bg} → ${target}`).toBe(target);
        expect(contrastRatio(p.fgColor, p.bgColor), `${bg} → ${target} fg`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("paletteFor", () => {
  it("uses the stored light trio when there is one", () => {
    const c = creative({
      lightBgColor: "#f7f9fc",
      lightFgColor: "#101418",
      lightAccentColor: "#0f7a5a",
    });
    expect(paletteFor(c, "light")).toEqual({
      bgColor: "#f7f9fc",
      fgColor: "#101418",
      accentColor: "#0f7a5a",
    });
  });

  it("derives a light palette for a creative that predates theme variants", () => {
    const p = paletteFor(creative(), "light");
    expect(themeOfBackground(p.bgColor)).toBe("light");
    expect(contrastRatio(p.fgColor, p.bgColor)).toBeGreaterThanOrEqual(4.5);
  });

  it("derives a dark palette when the primary trio is actually light", () => {
    // The stored trio is documented as dark but was never enforced. Serving a
    // white unit onto a dark page is the same glare bug in reverse.
    const c = creative({ bgColor: "#ffffff", fgColor: "#111111", accentColor: "#0a7d55" });
    expect(themeOfBackground(paletteFor(c, "dark").bgColor)).toBe("dark");
    // ...and the light request gets the advertiser's own colours untouched.
    expect(paletteFor(c, "light").bgColor).toBe("#ffffff");
  });

  it("partial light columns are ignored — all three or none", () => {
    const c = creative({ lightBgColor: "#f7f9fc" });
    expect(paletteFor(c, "light").bgColor).not.toBe("#f7f9fc");
  });
});

describe("resolveTheme", () => {
  it("prefers what the tag measured over the slot's stored default", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
  });

  it("falls back to the slot default when the request says nothing", () => {
    expect(resolveTheme(null, "light")).toBe("light");
    expect(resolveTheme("auto", "light")).toBe("light");
  });

  it("defaults to dark, which is what every unit rendered as before", () => {
    expect(resolveTheme(null, null)).toBe("dark");
    expect(resolveTheme("auto", "auto")).toBe("dark");
    expect(resolveTheme("nonsense", undefined)).toBe("dark");
  });
});

describe("rendered HTML", () => {
  it("paints a light unit with the light palette", () => {
    const c = creative({
      lightBgColor: "#f7f9fc",
      lightFgColor: "#101418",
      lightAccentColor: "#0f7a5a",
    });
    const html = renderCreativeHtml(c, "https://example.com", { theme: "light" });
    expect(html).toContain("#f7f9fc");
    expect(html).not.toContain(DARK.bgColor);
  });

  it("defaults to dark when no theme is asked for", () => {
    const html = renderCreativeHtml(creative(), "https://example.com");
    expect(html).toContain(DARK.bgColor);
  });

  it("uses a dark hairline on dark and a dark-ink hairline on light", () => {
    expect(hairline("dark")).toBe("rgba(255,255,255,.08)");
    expect(hairline("light")).toBe("rgba(0,0,0,.12)");
    const light = renderCreativeHtml(creative(), "https://example.com", { theme: "light" });
    // The white haze was invisible on a dark page and a grey smear on a light one.
    expect(light).not.toContain("rgba(255,255,255,.08)");
    expect(light).toContain("rgba(0,0,0,.12)");
  });

  it("renders every format in both themes without leaking the other palette", () => {
    for (const format of ["banner_300x250", "banner_728x90", "banner_320x50", "text_link"] as const) {
      const c = creative({
        format,
        lightBgColor: "#f7f9fc",
        lightFgColor: "#101418",
        lightAccentColor: "#0f7a5a",
      });
      const light = renderCreativeHtml(c, "https://example.com", { theme: "light" });
      expect(light, format).toContain("#f7f9fc");
      expect(light, format).not.toContain(DARK.bgColor);
    }
  });

  it("keeps a translucent background from making the CTA label see-through", () => {
    const c = creative({ format: "banner_728x90", bgColor: "#0b0d1080" });
    const html = renderCreativeHtml(c, "https://example.com");
    // The chip's ink is the background colour, and must be opaque.
    expect(html).toContain("color:#0b0d10;");
  });
});

describe("house ads", () => {
  it("has a light variant, not just the near-black one", () => {
    const dark = renderHouseAdHtml("text_link", "https://crawlproof.com", undefined, "dark");
    const light = renderHouseAdHtml("text_link", "https://crawlproof.com", undefined, "light");
    expect(dark).toContain("#070a10");
    expect(light).not.toContain("#070a10");
    expect(light).toContain("#f6f9fb");
  });

  it("is readable in both polarities", () => {
    for (const [bg, fg] of [
      ["#070a10", "#eef3f8"],
      ["#f6f9fb", "#0d1620"],
    ]) {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("luminance", () => {
  it("orders black, mid grey and white", () => {
    expect(luminance("#000000")).toBeLessThan(luminance("#808080"));
    expect(luminance("#808080")).toBeLessThan(luminance("#ffffff"));
  });
});
