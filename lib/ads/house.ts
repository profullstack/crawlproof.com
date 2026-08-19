import crypto from "node:crypto";
import { env } from "@/lib/env";
import { formatSpec, type AdCreative, type AdFormatId } from "./creative";
import { hexToRgba } from "./formats";
import { hairline, overImageInk, overlayInk, solid, type AdPalette, type AdTheme } from "./theme";
import { FEED_FORMAT_ID, TERMINAL_FORMAT_ID } from "./formats";
import { renderCreativeText, renderTerminalHtml } from "./terminal";
import { renderFeedHtml } from "./feeditem";
import type { Fill } from "./serve";

// Default "house" ad for the CrawlProof Ad Network. Shown when a slot has no
// eligible paid campaign, so a publisher's unit is never blank. Uses default
// AI-generated promo artwork (public/ads/house/*) with an overlaid pitch that
// links back to CrawlProof. House ads are not metered or billed.

// Until a slot has paid inventory, *every* fill on it is a house ad. With a
// single hard-coded creative that made the unit byte-identical on every
// request — an MOTD or SSH banner would print the same block forever and read
// as frozen (or cached) rather than live. So the house ad is a pool, and each
// fill draws from it at random: an unsold slot still rotates.
//
// `slug` is only for attribution — it rides the click URL as utm_content so we
// can tell which pitch actually converts. It is left off the terminal click
// URL, which is printed as literal text inside the ASCII box and has no room
// to spare.
type HouseCopy = {
  slug: string;
  headline: string;
  body: string;
  cta: string;
};

// Two audiences, since these render in front of developers who are just as
// likely to have a site to monetize as a product to sell.
const HOUSE_VARIANTS: readonly HouseCopy[] = [
  {
    slug: "your-ad-here",
    headline: "Your ad here",
    body: "Crypto pay-per-click ads for indie sites — no middlemen.",
    cta: "Advertise →",
  },
  {
    slug: "monetize-terminal",
    headline: "Monetize your terminal",
    body: "Plain-ASCII ads for MOTDs, SSH banners, and CLI tools.",
    cta: "Get a slot →",
  },
  {
    slug: "reach-developers",
    headline: "Reach developers where they work",
    body: "Put your product in front of shells, not ad blockers.",
    cta: "Start a campaign →",
  },
  {
    slug: "paid-in-crypto",
    headline: "Get paid in crypto",
    body: "Publishers keep the revenue. No invoices, no net-30.",
    cta: "Monetize →",
  },
  {
    slug: "no-javascript",
    headline: "Ads without JavaScript",
    body: "One HTTP call, plain text back. No iframe, no tracking pixel.",
    cta: "See the docs →",
  },
  {
    slug: "indie-budget",
    headline: "Advertise on an indie budget",
    body: "Pay per click, set a daily cap, stop whenever you want.",
    cta: "Advertise →",
  },
];

// One draw per fill. Callers must pick once and thread the result through, or
// the metered creative and the rendered HTML would disagree.
function pickHouse(): HouseCopy {
  return HOUSE_VARIANTS[Math.floor(Math.random() * HOUSE_VARIANTS.length)];
}

// Fraction of fills on a slot with eligible paid inventory that are given the
// CrawlProof house ad instead, to keep promoting the ad network. Not metered.
export const HOUSE_AD_ROTATION_RATE = 0.1;

function imageUrlFor(format: AdFormatId): string {
  const rect = format === "banner_300x250";
  return `${env.siteUrl}/ads/house/${rect ? "promo-rect" : "promo-wide"}.webp`;
}

/**
 * Artwork the house ad carries, per format.
 *
 * The feed unit gets none. Its body is `text` style — a single sponsored line
 * — so an `imageUrl` would never be rendered, and leaving one on the creative
 * would put a promo banner into the `imageUrl` field of every `as=fields`
 * payload, where a consumer templating its own item would reasonably render it.
 */
function houseImageFor(format: AdFormatId): string | null {
  return format === FEED_FORMAT_ID || format === TERMINAL_FORMAT_ID
    ? null
    : imageUrlFor(format);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHouseAdHtml(
  format: AdFormatId,
  clickUrl: string,
  copy: HouseCopy = pickHouse(),
  theme: AdTheme = "dark",
): string {
  const { w, h } = formatSpec(format);
  const HOUSE = copy;
  const p = housePalette(theme);
  const edge = hairline(theme);
  // Muted ink for the small-print label and the body line, derived from the
  // theme's foreground rather than hard-coded — the old #9fb0c3 / #c7d2de pair
  // were mid-greys tuned for near-black and vanished on a light card.
  const muted = hexToRgba(p.fgColor, 0.68);
  const bodyInk = hexToRgba(p.fgColor, 0.82);

  // Terminal ad — same ASCII artwork the /api/ads/motd endpoint serves, in a
  // <pre> for the web/iframe paths.
  if (format === TERMINAL_FORMAT_ID) {
    return renderTerminalHtml(houseCreative(format, copy), clickUrl, { theme });
  }

  // Feed ad — the same sponsored line the /api/ads/feed body carries, so an
  // unsold feed slot previews as what it would actually syndicate.
  if (format === FEED_FORMAT_ID) {
    return renderFeedHtml(houseCreative(format, copy), clickUrl, { label: "Sponsored" });
  }

  // Native text link — no artwork, single full-width line.
  if (format === "text_link") {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0}
      a{text-decoration:none;display:block}
      .cp-ad{display:flex;align-items:center;gap:8px;width:100%;height:${h}px;background:${p.bgColor};
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;padding:0 12px;
        overflow:hidden;border-radius:8px;border:1px solid ${edge};border-left:3px solid ${p.accentColor}}
    </style></head><body>
      <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">
        <span style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:${p.accentColor};flex:0 0 auto">CrawlProof Ads</span>
        <strong style="color:${p.fgColor};flex:0 0 auto;white-space:nowrap">${esc(HOUSE.headline)}</strong>
        <span style="color:${bodyInk};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto">— ${esc(HOUSE.body)}</span>
        <span style="color:${p.accentColor};font-weight:600;flex:0 0 auto;white-space:nowrap">${esc(HOUSE.cta)}</span>
      </a>
    </body></html>`;
  }

  const img = imageUrlFor(format);
  const isMobile = format === "banner_320x50";
  const isRect = format === "banner_300x250";
  const row = !isRect; // leaderboard + mobile are horizontal

  // Over the hero image the ink is the theme's over-image colour, not the
  // palette foreground: the scrim below is mixed from the same side, so on a
  // light unit the artwork fades to white and the copy has to go dark.
  const ink = overImageInk(theme);
  const inkMuted = hexToRgba(ink, 0.78);
  const label = `<span style="position:absolute;top:8px;left:10px;z-index:3;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:${hexToRgba(ink, 0.62)}">CrawlProof Ads</span>`;
  const headline = `<div style="font-weight:800;font-size:${isMobile ? 13 : isRect ? 20 : 17}px;line-height:1.1;color:${ink}">${esc(HOUSE.headline)}</div>`;
  const body = isMobile
    ? ""
    : `<div style="font-size:${isRect ? 13 : 12}px;color:${inkMuted};margin-top:4px;max-width:${isRect ? "100%" : "62%"}">${esc(HOUSE.body)}</div>`;
  const cta = `<span style="background:${p.accentColor};color:${solid(p.bgColor)};font-weight:700;border-radius:6px;padding:${isMobile ? "4px 8px" : "7px 12px"};font-size:${isMobile ? 11 : 13}px;white-space:nowrap">${esc(HOUSE.cta)}</span>`;

  const content = row
    ? `<div style="position:relative;z-index:2;display:flex;align-items:center;gap:10px;height:100%;padding:0 12px">
         <div style="min-width:0">${headline}${body}</div>
         <div style="margin-left:auto;flex:0 0 auto">${cta}</div>
       </div>`
    : `<div style="position:relative;z-index:2;display:flex;flex-direction:column;height:100%;padding:14px">
         <div style="margin-top:auto">${headline}${body}</div>
         <div style="margin-top:12px">${cta}</div>
       </div>`;

  const scrim = overlayInk(theme);
  const overlay = isRect
    ? `linear-gradient(180deg, ${hexToRgba(scrim, 0.12)} 0%, ${hexToRgba(scrim, 0.86)} 76%)`
    : `linear-gradient(90deg, ${hexToRgba(scrim, 0.92)} 0%, ${hexToRgba(scrim, 0.5)} 62%, ${hexToRgba(scrim, 0.2)} 100%)`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    a{text-decoration:none;display:block}
    .cp-ad{position:relative;width:${w}px;height:${h}px;overflow:hidden;border-radius:8px;
      border:1px solid ${edge};background:${p.bgColor};
      font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .cp-ad .bg{position:absolute;inset:0;z-index:0;background:url("${esc(img)}") center/cover no-repeat}
    .cp-ad .ov{position:absolute;inset:0;z-index:1;background:${overlay}}
  </style></head><body>
    <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">
      <div class="bg"></div><div class="ov"></div>${label}${content}
    </a>
  </body></html>`;
}

// CrawlProof's own palette, in both polarities. The light trio is hand-picked
// rather than derived: this is the brand's own ad, and the derived teal lands a
// shade off the green the marketing site actually uses.
export const HOUSE_DARK: AdPalette = {
  bgColor: "#070a10",
  fgColor: "#eef3f8",
  accentColor: "#6ee7b7",
};
export const HOUSE_LIGHT: AdPalette = {
  bgColor: "#f6f9fb",
  fgColor: "#0d1620",
  accentColor: "#0f7a5a",
};

export function housePalette(theme: AdTheme): AdPalette {
  return theme === "light" ? HOUSE_LIGHT : HOUSE_DARK;
}

function houseCreative(format: AdFormatId, copy: HouseCopy): AdCreative {
  return {
    format,
    headline: copy.headline,
    body: copy.body,
    ctaText: copy.cta,
    ...HOUSE_DARK,
    lightBgColor: HOUSE_LIGHT.bgColor,
    lightFgColor: HOUSE_LIGHT.fgColor,
    lightAccentColor: HOUSE_LIGHT.accentColor,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    logoUrl: null,
    imageUrl: houseImageFor(format),
  };
}

/** A default house-ad fill promoting the CrawlProof Ad Network. Not metered. */
export function houseFill(format: AdFormatId, theme: AdTheme = "dark"): Fill {
  // Drawn once here, then threaded through both the creative and the render so
  // a single fill can't advertise one pitch in its HTML and another in its text.
  const copy = pickHouse();
  // Terminals print the raw URL as literal text inside the ASCII box, so the
  // terminal house ad goes through the /h redirector, which re-applies the utm
  // params server-side. Spelling them out inline made the URL 59 characters —
  // wider than the 40 columns a 44-col box has to spend, so it got pushed
  // outside the frame. /h is 24, and still fits once a publisher's &s=<surface>
  // tag is appended.
  //
  // The feed unit takes the same short form, and for the same reason: as=text,
  // as=markdown and the terminal body style all print the URL as literal text.
  // /h re-applies the utm params server-side, so attribution is unchanged.
  const clickUrl =
    format === TERMINAL_FORMAT_ID || format === FEED_FORMAT_ID
      ? `${env.siteUrl}/h`
      : `${env.siteUrl}/?utm_source=house-ad&utm_medium=ad&utm_campaign=crawlproof-ads&utm_content=${copy.slug}`;
  const creative = houseCreative(format, copy);
  return {
    impressionId: crypto.randomUUID(),
    campaignId: "house",
    creativeId: "house",
    refSlug: "house",
    creative,
    clickUrl,
    html: renderHouseAdHtml(format, clickUrl, copy, theme),
    text: renderCreativeText(creative, clickUrl, { label: "CRAWLPROOF ADS" }),
    tier: "house",
  };
}
