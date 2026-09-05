import { describe, expect, it } from "vitest";
import { templateCopy, creativesFromCopy, AD_FORMAT_IDS } from "@/lib/ads/creative";
import type { SiteBrand } from "@/lib/ads/brand";

const brand: SiteBrand = {
  url: "https://nichedb.dev/",
  domain: "nichedb.dev",
  title: "NicheDB — sources in, feeds out",
  description: "An open, ever-growing database of real-time data. Follow a feed, get told. Web, RSS, API, CLI and MCP.",
  text: "NicheDB is a platform for databases that only ever grow.",
  logoUrl: null,
  ogImage: "https://nichedb.dev/icons/icon-512x512.png",
  themeColor: "#12161f",
  palette: ["#12161f", "#6ee7b7", "#ffffff"],
};

describe("template copy, for when no model has credit", () => {
  it("is the page's own words, within the creative limits", () => {
    const copy = templateCopy(brand);
    expect(copy.headline).toBe("NicheDB");
    expect(copy.shortHeadline).toBe("NicheDB");
    expect(copy.body.length).toBeLessThanOrEqual(130);
    expect(copy.body.startsWith("An open, ever-growing database")).toBe(true);
    expect(copy.ctaText).toBe("Learn more");
    expect(copy.bgColor).toBe("#12161f");
    // The accent is the first palette colour that is not the background.
    expect(copy.accentColor).toBe("#6ee7b7");
    expect(copy.summaryShort).toBe(brand.description);
  });

  it("clips a long title on a word and falls back to the domain", () => {
    const long = templateCopy({ ...brand, title: "A very long page title that keeps going well past the headline limit for banners" });
    expect(long.headline.length).toBeLessThanOrEqual(48);
    expect(long.headline.endsWith(" ")).toBe(false);
    expect(long.shortHeadline.split(" ").length).toBeLessThanOrEqual(4);
    const bare = templateCopy({ ...brand, title: "", description: "", text: "", themeColor: null, palette: [] });
    expect(bare.headline).toBe("nichedb.dev");
    expect(bare.body).toBe("Read more on nichedb.dev.");
    expect(bare.bgColor).toBe("#0b0d10");
  });

  it("yields one creative per format, with the page image as the hero", () => {
    const creatives = creativesFromCopy(brand, templateCopy(brand), brand.ogImage);
    expect(creatives.map((c) => c.format)).toEqual(AD_FORMAT_IDS);
    for (const creative of creatives) {
      expect(creative.imageUrl).toBe(brand.ogImage);
      expect(creative.headline.length).toBeGreaterThan(0);
      expect(creative.lightBgColor).toBeTruthy();
    }
  });
});
