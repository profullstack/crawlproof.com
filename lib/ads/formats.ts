// Pure, client-safe ad format constants + types. Kept free of any server-only
// imports (LLM SDKs, node built-ins, socks/undici) so client components can
// import format metadata without dragging the whole creative pipeline — and
// the Tor/socks stack — into the browser bundle.

export const AD_FORMATS = [
  { id: "banner_300x250", label: "Medium Rectangle", w: 300, h: 250 },
  { id: "banner_728x90", label: "Leaderboard", w: 728, h: 90 },
  { id: "banner_320x50", label: "Mobile Banner", w: 320, h: 50 },
  // Native, borderless single-line text ad. Renders full-width (the w/h below
  // is the nominal iframe box; the unit itself fills its container).
  { id: "text_link", label: "Text Link", w: 600, h: 40 },
] as const;

export type AdFormatId = (typeof AD_FORMATS)[number]["id"];
export const AD_FORMAT_IDS = AD_FORMATS.map((f) => f.id) as AdFormatId[];

export function formatSpec(id: AdFormatId) {
  return AD_FORMATS.find((f) => f.id === id) ?? AD_FORMATS[0];
}

// First alphanumeric char of the brand copy, for the monogram fallback shown
// when a creative has no logo. Falls back to a neutral mark so it's never empty.
export function brandInitial(s: string | null | undefined): string {
  const m = (s ?? "").match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "★";
}

// #rrggbb → rgba(). Used for the image overlay and the no-image brand tint so
// the medium-rectangle never renders as a dead flat block.
export function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return `rgba(7,10,16,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export type AdCreative = {
  format: AdFormatId;
  headline: string;
  body: string;
  ctaText: string;
  bgColor: string;
  fgColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl: string | null;
  imageUrl: string | null;
};
