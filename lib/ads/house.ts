import crypto from "node:crypto";
import { env } from "@/lib/env";
import { formatSpec, type AdCreative, type AdFormatId } from "./creative";
import { TERMINAL_FORMAT_ID } from "./formats";
import { renderCreativeText, renderTerminalHtml } from "./terminal";
import type { Fill } from "./serve";

// Default "house" ad for the CrawlProof Ad Network. Shown when a slot has no
// eligible paid campaign, so a publisher's unit is never blank. Uses default
// AI-generated promo artwork (public/ads/house/*) with an overlaid pitch that
// links back to CrawlProof. House ads are not metered or billed.

const HOUSE = {
  headline: "Your ad here",
  body: "Crypto pay-per-click ads for indie sites — no middlemen.",
  cta: "Advertise →",
} as const;

// Fraction of fills on a slot with eligible paid inventory that are given the
// CrawlProof house ad instead, to keep promoting the ad network. Not metered.
export const HOUSE_AD_ROTATION_RATE = 0.1;

function imageUrlFor(format: AdFormatId): string {
  const rect = format === "banner_300x250";
  return `${env.siteUrl}/ads/house/${rect ? "promo-rect" : "promo-wide"}.webp`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHouseAdHtml(format: AdFormatId, clickUrl: string): string {
  const { w, h } = formatSpec(format);

  // Terminal ad — same ASCII artwork the /api/ads/motd endpoint serves, in a
  // <pre> for the web/iframe paths.
  if (format === TERMINAL_FORMAT_ID) {
    return renderTerminalHtml(houseCreative(format), clickUrl);
  }

  // Native text link — no artwork, single full-width line.
  if (format === "text_link") {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0}
      a{text-decoration:none;display:block}
      .cp-ad{display:flex;align-items:center;gap:8px;width:100%;height:${h}px;background:#070a10;
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;padding:0 12px;
        overflow:hidden;border-radius:8px;border:1px solid rgba(255,255,255,.08);border-left:3px solid #6ee7b7}
    </style></head><body>
      <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">
        <span style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#6ee7b7;flex:0 0 auto">CrawlProof Ads</span>
        <strong style="color:#eef3f8;flex:0 0 auto;white-space:nowrap">${esc(HOUSE.headline)}</strong>
        <span style="color:#c7d2de;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto">— ${esc(HOUSE.body)}</span>
        <span style="color:#6ee7b7;font-weight:600;flex:0 0 auto;white-space:nowrap">${esc(HOUSE.cta)}</span>
      </a>
    </body></html>`;
  }

  const img = imageUrlFor(format);
  const isMobile = format === "banner_320x50";
  const isRect = format === "banner_300x250";
  const row = !isRect; // leaderboard + mobile are horizontal

  const label = `<span style="position:absolute;top:8px;left:10px;z-index:3;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#9fb0c3">CrawlProof Ads</span>`;
  const headline = `<div style="font-weight:800;font-size:${isMobile ? 13 : isRect ? 20 : 17}px;line-height:1.1;color:#eef3f8">${esc(HOUSE.headline)}</div>`;
  const body = isMobile
    ? ""
    : `<div style="font-size:${isRect ? 13 : 12}px;color:#c7d2de;margin-top:4px;max-width:${isRect ? "100%" : "62%"}">${esc(HOUSE.body)}</div>`;
  const cta = `<span style="background:#6ee7b7;color:#04121a;font-weight:700;border-radius:6px;padding:${isMobile ? "4px 8px" : "7px 12px"};font-size:${isMobile ? 11 : 13}px;white-space:nowrap">${esc(HOUSE.cta)}</span>`;

  const content = row
    ? `<div style="position:relative;z-index:2;display:flex;align-items:center;gap:10px;height:100%;padding:0 12px">
         <div style="min-width:0">${headline}${body}</div>
         <div style="margin-left:auto;flex:0 0 auto">${cta}</div>
       </div>`
    : `<div style="position:relative;z-index:2;display:flex;flex-direction:column;height:100%;padding:14px">
         <div style="margin-top:auto">${headline}${body}</div>
         <div style="margin-top:12px">${cta}</div>
       </div>`;

  const overlay = isRect
    ? "linear-gradient(180deg, rgba(7,10,16,.12) 0%, rgba(7,10,16,.86) 76%)"
    : "linear-gradient(90deg, rgba(7,10,16,.92) 0%, rgba(7,10,16,.5) 62%, rgba(7,10,16,.2) 100%)";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    a{text-decoration:none;display:block}
    .cp-ad{position:relative;width:${w}px;height:${h}px;overflow:hidden;border-radius:8px;
      border:1px solid rgba(255,255,255,.08);background:#070a10;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .cp-ad .bg{position:absolute;inset:0;z-index:0;background:url("${esc(img)}") center/cover no-repeat}
    .cp-ad .ov{position:absolute;inset:0;z-index:1;background:${overlay}}
  </style></head><body>
    <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored">
      <div class="bg"></div><div class="ov"></div>${label}${content}
    </a>
  </body></html>`;
}

function houseCreative(format: AdFormatId): AdCreative {
  return {
    format,
    headline: HOUSE.headline,
    body: HOUSE.body,
    ctaText: HOUSE.cta,
    bgColor: "#070a10",
    fgColor: "#eef3f8",
    accentColor: "#6ee7b7",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    logoUrl: null,
    imageUrl: imageUrlFor(format),
  };
}

/** A default house-ad fill promoting the CrawlProof Ad Network. Not metered. */
export function houseFill(format: AdFormatId): Fill {
  // Terminals print the raw URL, so the terminal house ad uses a short one that
  // fits the ASCII box instead of the full utm_campaign query.
  const clickUrl =
    format === TERMINAL_FORMAT_ID
      ? `${env.siteUrl}/?utm_source=house-ad&utm_medium=motd`
      : `${env.siteUrl}/?utm_source=house-ad&utm_medium=ad&utm_campaign=crawlproof-ads`;
  const creative = houseCreative(format);
  return {
    impressionId: crypto.randomUUID(),
    campaignId: "house",
    creativeId: "house",
    refSlug: "house",
    creative,
    clickUrl,
    html: renderHouseAdHtml(format, clickUrl),
    text: renderCreativeText(creative, clickUrl, { label: "CRAWLPROOF ADS" }),
    tier: "house",
  };
}
