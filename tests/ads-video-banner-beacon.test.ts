import { describe, expect, it } from "vitest";
import { bannerBeaconScript, injectBannerBeacon } from "@/lib/ads/video/bannerBeacon";
import { normalizePlacement } from "@/lib/ads/video/decisions";
import { placementLabel, videoFunnelRow } from "@/lib/ads/video/stats";

const DECISION = "11111111-2222-4333-8444-555555555555";

describe("bannerBeaconScript", () => {
  const script = bannerBeaconScript(DECISION, "https://crawlproof.com/");

  it("beacons with an image, not a fetch", () => {
    // An <img> is governed by the publisher's img-src, which an ad unit
    // already needs. A fetch would need a connect-src entry nobody granted.
    expect(script).toContain("new Image()");
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("XMLHttpRequest");
  });

  it("points at the pixel endpoint with the decision id, and trims the origin slash", () => {
    expect(script).toContain("https://crawlproof.com/api/ads/video/events");
    expect(script).not.toContain("crawlproof.com//api");
    expect(script).toContain(DECISION);
  });

  it("gates the start on visibility, so an off-screen autoplay is not a view", () => {
    expect(script).toContain("IntersectionObserver");
    expect(script).toContain("0.5");
  });

  it("counts one loop only", () => {
    // currentTime going backwards is the wrap; a looping element never fires
    // 'ended', so without this a banner would report a completion per loop.
    expect(script).toContain("t + 0.25 < last");
    expect(script).toContain("done = true");
  });

  it("guards every event so a retry cannot double-count", () => {
    expect(script).toContain("if (sent[t]) return;");
  });

  it("cannot throw into the publisher's page", () => {
    expect(script.startsWith("<script>(function(){\n  try {")).toBe(true);
    expect(script).toContain("catch (_) {}");
  });
});

describe("injectBannerBeacon", () => {
  it("puts the script before </body>, where the media element already exists", () => {
    const out = injectBannerBeacon("<html><body><video></video></body></html>", "<script></script>");
    expect(out).toBe("<html><body><video></video><script></script></body></html>");
  });

  it("appends when there is no body to find, rather than dropping the script", () => {
    expect(injectBannerBeacon("<div>x</div>", "<s>")).toBe("<div>x</div><s>");
  });
});

describe("in_banner placement", () => {
  it("is accepted, and anything invented is not", () => {
    expect(normalizePlacement("in_banner")).toBe("in_banner");
    expect(normalizePlacement("in_banner_2")).toBe("preroll");
  });

  it("reads as its own product in a report", () => {
    expect(placementLabel("in_banner")).toBe("in-banner");
    expect(placementLabel("preroll")).toBe("pre-roll");
  });

  it("carries placement through the funnel row, defaulting to preroll", () => {
    expect(videoFunnelRow({ placement: "in_banner" }).placement).toBe("in_banner");
    // A row from before the split is a pre-roll; that is what existed then.
    expect(videoFunnelRow({}).placement).toBe("preroll");
  });
});
