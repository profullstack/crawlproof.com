import { describe, expect, it } from "vitest";
import {
  AD_FORMATS,
  AD_FORMAT_IDS,
  DESIGN_FORMATS,
  DESIGN_FORMAT_IDS,
  PUBLISHER_FORMAT_IDS,
  PUBLISHER_TEXT_FORMAT_IDS,
  PUBLISHER_FEED_FORMAT_IDS,
  STREAMING_FORMAT_IDS,
  VIDEO_FORMAT_ID,
  fitAdFormat,
  formatSpec,
  isStreamingFormat,
} from "@/lib/ads/formats";
import { creativesFromCopy, templateCopy } from "@/lib/ads/creative";
import type { SiteBrand } from "@/lib/ads/brand";

const brand: SiteBrand = {
  url: "https://nichedb.dev/",
  domain: "nichedb.dev",
  title: "NicheDB",
  description: "An open, ever-growing database of real-time data.",
  text: "NicheDB is a platform for databases that only ever grow.",
  logoUrl: null,
  ogImage: "https://nichedb.dev/icons/icon-512x512.png",
  themeColor: "#12161f",
  palette: ["#12161f", "#6ee7b7", "#ffffff"],
};

// The display formats as they stood before the pre-roll was registered. Spelled
// out rather than derived, so that a change to the registry has to be a
// deliberate edit here too.
const FORMATS_BEFORE_VIDEO = [
  "banner_300x250",
  "banner_728x90",
  "banner_320x50",
  "text_link",
  "terminal_ascii",
  "feed_item",
];

describe("the streaming pre-roll is registered", () => {
  it("exists as a format with a real 16:9 master frame", () => {
    expect(AD_FORMAT_IDS).toContain(VIDEO_FORMAT_ID);
    const spec = formatSpec(VIDEO_FORMAT_ID);
    expect([spec.w, spec.h]).toEqual([1920, 1080]);
    expect(isStreamingFormat(VIDEO_FORMAT_ID)).toBe(true);
    expect(isStreamingFormat("banner_300x250")).toBe(false);
    expect(isStreamingFormat(null)).toBe(false);
  });
});

describe("registering it changed nothing about the existing formats", () => {
  it("leaves the design fan-out exactly as it was", () => {
    expect(DESIGN_FORMAT_IDS).toEqual(FORMATS_BEFORE_VIDEO);
    expect(DESIGN_FORMATS.map((f) => f.id)).toEqual(FORMATS_BEFORE_VIDEO);
  });

  it("generates one creative per design format and none for video", () => {
    const creatives = creativesFromCopy(brand, templateCopy(brand), brand.ogImage);
    expect(creatives.map((c) => c.format)).toEqual(FORMATS_BEFORE_VIDEO);
    // The specific failure this guards: a video creative carrying a headline
    // and a palette, marked ready alongside its siblings, that an HTML renderer
    // would then draw as a banner.
    expect(creatives.some((c) => isStreamingFormat(c.format))).toBe(false);
  });

  it("keeps video out of every publisher-facing format list", () => {
    for (const list of [
      PUBLISHER_FORMAT_IDS,
      PUBLISHER_TEXT_FORMAT_IDS,
      PUBLISHER_FEED_FORMAT_IDS,
    ]) {
      expect(list).not.toContain(VIDEO_FORMAT_ID);
    }
    // /ad.js and the GitHub auto-installer embed exactly this list.
    expect(PUBLISHER_FORMAT_IDS).toEqual([
      "banner_300x250",
      "banner_728x90",
      "banner_320x50",
      "text_link",
    ]);
  });

  it("does not disturb display format negotiation", () => {
    // A leaderboard on a phone still downgrades to the rectangle, and the
    // registry's extra entry does not become a fallback candidate.
    expect(fitAdFormat("banner_728x90", 390, FORMATS_BEFORE_VIDEO)).toBe("banner_300x250");
    expect(fitAdFormat("banner_300x250", 1200, FORMATS_BEFORE_VIDEO)).toBe("banner_300x250");
    expect(fitAdFormat("terminal_ascii", null, FORMATS_BEFORE_VIDEO)).toBe("terminal_ascii");
  });
});

describe("an unrendered video cannot reach the display serving path", () => {
  // fitAdFormat is the single gate in front of serveAd(), which renders HTML
  // and ASCII. Refusing there is what makes this true regardless of how a slot
  // is configured — including a slot that has somehow been given the format.
  it("refuses video even when the slot offers it", () => {
    expect(fitAdFormat(VIDEO_FORMAT_ID, 1920, [...FORMATS_BEFORE_VIDEO, VIDEO_FORMAT_ID])).toBeNull();
    expect(fitAdFormat(VIDEO_FORMAT_ID, null, [VIDEO_FORMAT_ID])).toBeNull();
    // No slot list at all normally means "no basis to second-guess"; video is
    // still refused.
    expect(fitAdFormat(VIDEO_FORMAT_ID, 1920, null)).toBeNull();
  });

  it("refuses every streaming format, not just the one we happen to have", () => {
    for (const id of STREAMING_FORMAT_IDS) {
      expect(fitAdFormat(id, 1280, AD_FORMATS.map((f) => f.id))).toBeNull();
    }
  });
});

describe("the design-object write path refuses video", () => {
  // cleanCreative() is not exported, so this asserts the allowlist it is built
  // from. The hole it closes: a crafted updateCreatives payload naming
  // video_preroll_5s would otherwise be accepted as a design object and written
  // as a creative with a headline, a palette, and no media behind it.
  it("allowlists design formats, not the whole registry", () => {
    expect(DESIGN_FORMAT_IDS).not.toContain(VIDEO_FORMAT_ID);
    expect(AD_FORMAT_IDS).toContain(VIDEO_FORMAT_ID);
    expect(DESIGN_FORMAT_IDS.length).toBe(AD_FORMAT_IDS.length - STREAMING_FORMAT_IDS.length);
  });
});
