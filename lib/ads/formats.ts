// Pure, client-safe ad format constants + types. Kept free of any server-only
// imports (LLM SDKs, node built-ins, socks/undici) so client components can
// import format metadata without dragging the whole creative pipeline — and
// the Tor/socks stack — into the browser bundle.

import {
  derivePalette,
  overlayInk,
  parseColor,
  themeOfBackground,
  type AdPalette,
  type AdTheme,
} from "./theme";

/**
 * How opaque the readability scrim over hero imagery is allowed to get.
 *
 * It used to reach 0.86, which is close enough to opaque that the bottom third
 * of every rectangle collapsed into a flat block of the theme's ink. That is
 * most of the unit, and it hid the one thing a display ad has to sell: the
 * artwork. 0.6 leaves the picture visible all the way down.
 *
 * The contrast the scrim no longer supplies comes from `overImageShadow`
 * instead — a shadow follows the glyphs, so it buys legibility over exactly
 * the pixels the copy covers rather than over the whole lower half.
 */
export const SCRIM_ALPHA = 0.6;

/**
 * The gradient laid over a hero image so copy stays readable on top of it.
 *
 * Mixed from the theme's own ink rather than the creative's background: a light
 * unit needs to fade the image towards white, and an alpha-washed background
 * would leave the headline sitting on raw photo.
 *
 * Vertical for the rectangle, where the copy stacks at the bottom; horizontal
 * for the leaderboard and mobile strips, where it sits on the left and the
 * image has to survive on the right.
 */
export function imageScrim(theme: AdTheme, axis: "vertical" | "horizontal" = "vertical"): string {
  const ink = overlayInk(theme);
  return axis === "vertical"
    ? `linear-gradient(180deg, ${hexToRgba(ink, 0.1)} 0%, ${hexToRgba(ink, SCRIM_ALPHA)} 70%)`
    : `linear-gradient(90deg, ${hexToRgba(ink, SCRIM_ALPHA)} 0%, ${hexToRgba(ink, 0.34)} 62%, ${hexToRgba(ink, 0.12)} 100%)`;
}

/**
 * Text shadow for copy sitting on hero imagery, mixed from the same ink as the
 * scrim. Two shadows on purpose: a tight one for edge definition against busy
 * detail, and a wide soft one that darkens (or lightens) the few pixels around
 * each glyph so the copy holds even where the image runs bright behind it.
 */
export function overImageShadow(theme: AdTheme): string {
  const ink = overlayInk(theme);
  return `0 1px 2px ${hexToRgba(ink, 0.9)}, 0 0 12px ${hexToRgba(ink, 0.75)}`;
}

export const AD_FORMATS = [
  { id: "banner_300x250", label: "Medium Rectangle", w: 300, h: 250 },
  { id: "banner_728x90", label: "Leaderboard", w: 728, h: 90 },
  { id: "banner_320x50", label: "Mobile Banner", w: 320, h: 50 },
  // Native, borderless single-line text ad. Renders full-width (the w/h below
  // is the nominal iframe box; the unit itself fills its container).
  { id: "text_link", label: "Text Link", w: 600, h: 40 },
  // ASCII box for terminals — SSH banners, shell MOTDs, BBS screens, CLI tools.
  // There is no pixel box: w/h below is only the nominal size used by the web
  // preview when the same creative is rendered in a <pre>. The real dimension
  // is TERMINAL_COLS (see ./terminal).
  { id: "terminal_ascii", label: "Terminal (ASCII)", w: 600, h: 148 },
  // Syndication item — an RSS <item> / Atom <entry> / JSON Feed item, spliced
  // into somebody else's feed document. Like the terminal format there is no
  // pixel box: w/h is only the nominal size the web preview uses when the same
  // creative is rendered as HTML. The real dimension is "one item".
  { id: "feed_item", label: "Feed (RSS/Atom/JSON)", w: 600, h: 120 },
] as const;

export type AdFormatId = (typeof AD_FORMATS)[number]["id"];
export const AD_FORMAT_IDS = AD_FORMATS.map((f) => f.id) as AdFormatId[];

// Sizes offered to publishers on the Monetize page — the ones they can copy an
// embed for and install. A subset of AD_FORMATS that grows as each size is
// surfaced (one PR per size). Keep the medium rectangle first: it's the safe
// default the auto-installer falls back to.
//
// WEB ONLY: these are the formats rendered as an <iframe> by /ad.js and dropped
// into HTML by the GitHub auto-installer. Text/terminal formats must not be in
// this list — they're fetched, not embedded.
export const PUBLISHER_FORMAT_IDS: AdFormatId[] = [
  "banner_300x250",
  "banner_728x90",
  "banner_320x50",
  "text_link",
];

/**
 * Formats that occupy a fixed pixel box and can therefore fail to fit.
 *
 * `text_link` is deliberately absent: it renders full-width into whatever it is
 * given, so its nominal 600px is a preview size rather than a requirement. The
 * terminal and feed units have no pixel box at all.
 */
const FIXED_WIDTH_FORMATS: AdFormatId[] = ["banner_300x250", "banner_728x90", "banner_320x50"];

/**
 * The format to actually serve, given what the publisher asked for and how much
 * room their container turned out to have.
 *
 * The tag clamps its iframe to `max-width:100%` with scrolling off, so a unit
 * wider than its container does not shrink — it loses its right-hand side,
 * which is where the CTA sits. A 728x90 asked for on a phone was measured at
 * 0.01% CTR against 0.34% for a rectangle on the same devices: the click target
 * was simply off-screen. So an explicit `data-format` is honoured only while it
 * fits, and downgraded when it does not.
 *
 * `allowed` is the slot's own format list, because serving refuses anything
 * outside it — a downgrade to a format the slot never opted into would return
 * no fill at all, which is worse than the clipped ad we started with.
 *
 * Returns null only when the request was never servable (the slot does not
 * offer the requested format), preserving the previous refusal exactly.
 */
export function fitAdFormat(
  requested: AdFormatId,
  width: number | null | undefined,
  allowed: readonly string[] | null | undefined,
): AdFormatId | null {
  const offers = (f: AdFormatId) => !Array.isArray(allowed) || allowed.includes(f);
  if (!offers(requested)) return null;

  // No measurement (an older tag, or a non-web consumer like the MOTD and feed
  // endpoints) means no basis to second-guess the publisher.
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return requested;
  if (!FIXED_WIDTH_FORMATS.includes(requested)) return requested;
  if (formatSpec(requested).w <= width) return requested;

  const candidates = FIXED_WIDTH_FORMATS.filter(offers);
  const fits = candidates.filter((f) => formatSpec(f).w <= width);
  if (fits.length === 0) {
    // Nothing fits. A slightly clipped unit still beats a blank one, so fall
    // back to the narrowest thing the slot offers rather than giving up.
    return candidates.reduce((a, b) => (formatSpec(b).w < formatSpec(a).w ? b : a), requested);
  }
  // Largest by area, not by width: at 390px both the rectangle (300) and the
  // mobile strip (320) fit, and the rectangle converts roughly 7x better.
  const area = (f: AdFormatId) => formatSpec(f).w * formatSpec(f).h;
  return fits.reduce((a, b) => (area(b) > area(a) ? b : a));
}

// The terminal format id, kept as a named constant since several call sites
// (serving, the MOTD endpoint, the publisher snippet) branch on it.
export const TERMINAL_FORMAT_ID = "terminal_ascii" as const;

// The feed format id. Same reasoning as above — serving, /api/ads/feed and the
// publisher snippets all branch on it. Declared here rather than imported from
// ./feeditem so that this module stays the one place a format id is named, and
// so ./feeditem can import ./formats without a cycle.
export const FEED_FORMAT_ID = "feed_item" as const;

// Caption for the terminal unit's real dimension — it has columns, not pixels.
export const TERMINAL_COLS_LABEL = "76 cols";

// Same for the feed unit, whose dimension is an item in a river.
export const FEED_ITEM_LABEL = "1 item";

// Formats a publisher consumes over plain HTTP as text rather than embedding —
// `curl https://crawlproof.com/api/ads/motd?slot=<id>` in a login banner, MOTD,
// or CLI. Shown as their own group on the Monetize page.
export const PUBLISHER_TEXT_FORMAT_IDS: AdFormatId[] = [TERMINAL_FORMAT_ID];

// Formats a publisher splices into a document they generate themselves — an
// RSS/Atom/JSON feed, a newsletter, a static-site build. Fetched at build time
// and pasted into the output, so like the text formats they are never embedded
// and never rendered by /ad.js.
export const PUBLISHER_FEED_FORMAT_IDS: AdFormatId[] = [FEED_FORMAT_ID];

export function formatSpec(id: AdFormatId) {
  return AD_FORMATS.find((f) => f.id === id) ?? AD_FORMATS[0];
}

// First alphanumeric char of the brand copy, for the monogram fallback shown
// when a creative has no logo. Falls back to a neutral mark so it's never empty.
export function brandInitial(s: string | null | undefined): string {
  const m = (s ?? "").match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "★";
}

// #rrggbb (or #rrggbbaa) → rgba(). Used for the image overlay and the no-image
// brand tint so the medium-rectangle never renders as a dead flat block.
//
// `a` MULTIPLIES the colour's own alpha rather than replacing it, so a
// half-transparent brand colour stays half-transparent when it is asked for at
// 18%. Call sites that need an opaque ink should pass the colour through
// `solid()` first.
export function hexToRgba(hex: string, a: number): string {
  const c = parseColor(hex);
  if (!c) return `rgba(7,10,16,${a})`;
  const alpha = Math.round(c.a * a * 1000) / 1000;
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

export type AdCreative = {
  format: AdFormatId;
  headline: string;
  body: string;
  ctaText: string;
  /**
   * The advertiser's primary palette. Historically — and still, for every
   * creative that predates theme variants — this is the dark-page palette.
   */
  bgColor: string;
  fgColor: string;
  accentColor: string;
  /**
   * Counterpart palette for light publisher pages. Null on creatives that
   * predate theme variants; `paletteFor()` derives one on the fly so a missing
   * variant is a quality difference, never a broken render.
   */
  lightBgColor?: string | null;
  lightFgColor?: string | null;
  lightAccentColor?: string | null;
  fontFamily: string;
  logoUrl: string | null;
  imageUrl: string | null;
};

/**
 * The colour trio to render this creative with on a page of `theme`.
 *
 * Light is stored when we have it and derived when we don't. Dark reads the
 * primary trio — unless the advertiser picked a light background there, in
 * which case rendering it on a dark page would be the very glare this feature
 * exists to remove, so it gets derived too.
 */
export function paletteFor(creative: AdCreative, theme: AdTheme): AdPalette {
  const primary: AdPalette = {
    bgColor: creative.bgColor,
    fgColor: creative.fgColor,
    accentColor: creative.accentColor,
  };

  if (theme === "light") {
    if (creative.lightBgColor && creative.lightFgColor && creative.lightAccentColor) {
      return {
        bgColor: creative.lightBgColor,
        fgColor: creative.lightFgColor,
        accentColor: creative.lightAccentColor,
      };
    }
    return themeOfBackground(primary.bgColor) === "light"
      ? primary
      : derivePalette(primary, "light");
  }

  return themeOfBackground(primary.bgColor) === "dark" ? primary : derivePalette(primary, "dark");
}
