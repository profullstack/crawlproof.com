import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import type { AdCreative } from "@/lib/ads/formats";
import { renderCreativeText, TERMINAL_COLS } from "@/lib/ads/terminal";
import { houseFill } from "@/lib/ads/house";
import { TERMINAL_FORMAT_ID } from "@/lib/ads/formats";
import { GET as houseRedirect } from "@/app/h/route";

// A terminal ad is printed into a box the caller sized. Anything wider than
// that box is the renderer failing to honour the width it was given — and the
// narrowest supported box, 44 cols, has only 40 usable columns, so it is where
// every width bug shows up first.

const MIN_COLS = 44;
const WIDTHS = [44, 52, 60, 72, 120];

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "terminal_ascii",
    headline: "Ship faster with CrawlProof",
    body: "AI-readable audits for your site, in one command.",
    ctaText: "Try it free",
    bgColor: "#0b0d10",
    fgColor: "#e7e9ee",
    accentColor: "#6ee7b7",
    fontFamily: "system-ui",
    logoUrl: null,
    imageUrl: null,
    ...over,
  };
}

const SHORT_URL = "https://crawlproof.com/h?s=motd";

describe("renderCreativeText call-to-action width", () => {
  // Regression: the CTA was the one piece of advertiser copy that was never
  // wrapped. `row` clamps its padding at zero, so an over-long CTA didn't
  // error — it silently emitted a row wider than the frame.
  const LONG_CTA = "Click here to start your completely free thirty day trial today";

  it("wraps a call-to-action that is wider than the box", () => {
    for (const cols of WIDTHS) {
      const out = renderCreativeText(creative({ ctaText: LONG_CTA }), SHORT_URL, { cols });
      for (const line of out.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("keeps the box rectangular with a long call-to-action at the minimum width", () => {
    const out = renderCreativeText(creative({ ctaText: LONG_CTA }), SHORT_URL, { cols: MIN_COLS });
    const framed = out.split("\n").filter((l) => l.startsWith("|") || l.startsWith("+"));
    for (const line of framed) expect(line).toHaveLength(MIN_COLS);
    // Wrapped, not truncated — the words still all survive somewhere.
    for (const word of LONG_CTA.split(" ")) expect(out).toContain(word);
  });

  it("hard-splits a single unbroken call-to-action word", () => {
    const out = renderCreativeText(creative({ ctaText: "x".repeat(200) }), SHORT_URL, {
      cols: MIN_COLS,
    });
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(MIN_COLS);
  });

  it("does not break the coloured render's visible width", () => {
    const out = renderCreativeText(creative({ ctaText: LONG_CTA }), SHORT_URL, {
      cols: MIN_COLS,
      color: true,
    });
    for (const line of out.split("\n")) {
      const bare = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(bare.length).toBeLessThanOrEqual(MIN_COLS);
    }
  });
});

describe("house ad click URL width", () => {
  // The house URL used to spell its utm params out inline, which made it 59
  // characters and forced it outside the frame on any narrow box. It now goes
  // through /h and has to stay short enough to sit inside the box, including
  // the publisher's ?s=<surface> tag.
  // Measure the URL the code actually builds, not a stand-in — otherwise a
  // regression back to the long inline-utm form would sail past. env.siteUrl is
  // localhost under test, so re-host it on the real (longer) production origin
  // and add the surface tag /api/ads/motd appends, for the true worst case.
  function productionClickUrl(): string {
    const fill = houseFill(TERMINAL_FORMAT_ID);
    const u = new URL(fill.clickUrl);
    const prod = new URL(`https://crawlproof.com${u.pathname}${u.search}`);
    prod.searchParams.set("s", "motd");
    return prod.toString();
  }

  it("fits inside the frame at every supported width", () => {
    for (const cols of WIDTHS) {
      const fill = houseFill(TERMINAL_FORMAT_ID);
      const clickUrl = productionClickUrl();
      const text = renderCreativeText(fill.creative, clickUrl, {
        cols,
        label: "CRAWLPROOF ADS",
      });
      const lines = text.split("\n");
      // Nothing dangles below or beside the box.
      for (const line of lines) {
        expect(line).toHaveLength(cols);
        expect(line.startsWith("|") || line.startsWith("+")).toBe(true);
      }
      expect(text).toContain(clickUrl);
    }
  });

  it("points the terminal house ad at the short redirector", () => {
    expect(houseFill(TERMINAL_FORMAT_ID).clickUrl).toMatch(/\/h$/);
  });

  it("leaves the non-terminal house ad on the long, descriptive URL", () => {
    // No width constraint in an iframe, so keep the richer attribution there.
    expect(houseFill("banner_300x250").clickUrl).toContain("utm_campaign=crawlproof-ads");
  });
});

describe("/h house-ad redirector", () => {
  function get(url: string) {
    return houseRedirect(new Request(url) as NextRequest);
  }

  it("redirects to the site with house-ad attribution", () => {
    const res = get("https://crawlproof.com/h");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("utm_source")).toBe("house-ad");
    expect(loc.searchParams.get("utm_medium")).toBe("terminal");
  });

  it("carries the publisher surface tag through as utm_content", () => {
    const loc = new URL(get("https://crawlproof.com/h?s=bbs").headers.get("location") ?? "");
    expect(loc.searchParams.get("utm_content")).toBe("bbs");
  });

  it("sanitises a hostile surface tag", () => {
    const loc = new URL(
      get("https://crawlproof.com/h?s=%22%3E%3Cscript%3E").headers.get("location") ?? "",
    );
    expect(loc.searchParams.get("utm_content") ?? "").toMatch(/^[\w.-]*$/);
  });

  it("omits utm_content when no tag was given", () => {
    const loc = new URL(get("https://crawlproof.com/h").headers.get("location") ?? "");
    expect(loc.searchParams.has("utm_content")).toBe(false);
  });
});

describe("default width still behaves", () => {
  it("keeps the standard creative on one CTA+URL line at the default width", () => {
    const out = renderCreativeText(creative(), SHORT_URL, { cols: TERMINAL_COLS });
    expect(out).toContain(`Try it free -> ${SHORT_URL}`);
  });
});
