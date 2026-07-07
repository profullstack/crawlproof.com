// Pure, client-safe ad format constants + types. Kept free of any server-only
// imports (LLM SDKs, node built-ins, socks/undici) so client components can
// import format metadata without dragging the whole creative pipeline — and
// the Tor/socks stack — into the browser bundle.

export const AD_FORMATS = [
  { id: "banner_300x250", label: "Medium Rectangle", w: 300, h: 250 },
  { id: "banner_728x90", label: "Leaderboard", w: 728, h: 90 },
  { id: "banner_320x50", label: "Mobile Banner", w: 320, h: 50 },
] as const;

export type AdFormatId = (typeof AD_FORMATS)[number]["id"];
export const AD_FORMAT_IDS = AD_FORMATS.map((f) => f.id) as AdFormatId[];

export function formatSpec(id: AdFormatId) {
  return AD_FORMATS.find((f) => f.id === id) ?? AD_FORMATS[0];
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
