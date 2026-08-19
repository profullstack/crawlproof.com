// Light/dark palettes for ad creatives.
//
// Every creative carries two colour trios: the one the advertiser picked, and
// a counterpart for publisher pages of the opposite polarity. A single palette
// cannot work everywhere — a dark unit on a plain black-on-white blog reads as
// a hole punched in the page, and a light unit on a dark dashboard glares.
//
// Pure and client-safe: no I/O, no server-only imports. The renderer, the
// editor preview and the backfill script all derive colours through here, so a
// backfilled palette and a freshly generated one can never disagree.

export type AdTheme = "light" | "dark";

/** What a slot or a request may ask for. 'auto' means "work it out". */
export type AdThemePref = AdTheme | "auto";

export type AdPalette = {
  bgColor: string;
  fgColor: string;
  accentColor: string;
};

export type Rgba = { r: number; g: number; b: number; a: number };

export const AD_THEMES: AdTheme[] = ["light", "dark"];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const clamp255 = (n: number) => clamp(Math.round(n), 0, 255);

export function isAdTheme(v: string | null | undefined): v is AdTheme {
  return v === "light" || v === "dark";
}

export function isAdThemePref(v: string | null | undefined): v is AdThemePref {
  return isAdTheme(v) || v === "auto";
}

/**
 * Parse #rgb, #rgba, #rrggbb or #rrggbbaa.
 *
 * The 4- and 8-digit forms are what the editor's alpha slider writes: CSS has
 * understood them since 2017 and they survive a `text` column untouched, which
 * an `rgba()` string would not — every call site here expects a hex.
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  const s = String(input ?? "")
    .trim()
    .replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(s)) return null;
  const hex =
    s.length === 3 || s.length === 4
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  if (hex.length !== 6 && hex.length !== 8) return null;
  const n = parseInt(hex.slice(0, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
}

/** Back to #rrggbb, or #rrggbbaa when the colour is not fully opaque. */
export function toHex({ r, g, b, a }: Rgba): string {
  const two = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  const base = `#${two(r)}${two(g)}${two(b)}`;
  return a >= 1 ? base : `${base}${two(a * 255)}`;
}

/** True when the colour carries an alpha channel below 1. */
export function hasAlpha(color: string): boolean {
  const c = parseColor(color);
  return !!c && c.a < 1;
}

/**
 * Strip alpha.
 *
 * Used where a colour is being borrowed as *ink* — the label inside a CTA chip
 * takes the background colour so it punches out of the accent. A translucent
 * background there would render the label see-through over the chip.
 */
export function solid(color: string): string {
  const c = parseColor(color);
  return c ? toHex({ ...c, a: 1 }) : color;
}

const overWhite = (v: number, a: number) => v * a + 255 * (1 - a);

/** Composite a translucent colour over white — what a bare page actually shows. */
export function flatten(color: string): string {
  const c = parseColor(color);
  if (!c) return color;
  if (c.a >= 1) return toHex(c);
  return toHex({ r: overWhite(c.r, c.a), g: overWhite(c.g, c.a), b: overWhite(c.b, c.a), a: 1 });
}

/** WCAG relative luminance, 0 (black) → 1 (white). Alpha is flattened first. */
export function luminance(color: string): number {
  const c = parseColor(flatten(color));
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio between two colours, 1 → 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Which theme a background colour belongs to.
 *
 * A translucent background is composited over white before judging: that is
 * what a viewer actually sees on a page with no CSS of its own, which is the
 * exact case this whole feature exists for.
 */
export function themeOfBackground(color: string): AdTheme {
  if (!parseColor(color)) return "dark";
  return luminance(color) >= 0.5 ? "light" : "dark";
}

// ---------------------------------------------------------------------------
// HSL, for deriving a counterpart palette that keeps the brand's hue
// ---------------------------------------------------------------------------

export type Hsl = { h: number; s: number; l: number; a: number };

export function toHsl(color: string): Hsl {
  const c = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l, a: c.a };
}

export function fromHsl({ h, s, l, a }: Hsl): string {
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const r = sat === 0 ? lig : channel(h + 1 / 3);
  const g = sat === 0 ? lig : channel(h);
  const b = sat === 0 ? lig : channel(h - 1 / 3);
  return toHex({ r: r * 255, g: g * 255, b: b * 255, a: clamp(a, 0, 1) });
}

/** Push a colour's lightness until it clears `min` contrast against `against`. */
export function ensureContrast(color: string, against: string, min = 4.5): string {
  if (contrastRatio(color, against) >= min) return color;
  const src = toHsl(color);
  // Move away from the background: darken on light, lighten on dark.
  const dir = themeOfBackground(against) === "light" ? -1 : 1;
  for (let step = 1; step <= 20; step++) {
    const candidate = fromHsl({ ...src, l: clamp(src.l + dir * step * 0.05, 0, 1) });
    if (contrastRatio(candidate, against) >= min) return candidate;
  }
  // Nothing in this hue worked — plain ink always clears it.
  return themeOfBackground(against) === "light" ? "#111418" : "#f5f7fa";
}

/**
 * Build the counterpart palette for `target`, keeping the brand's hues.
 *
 * Only lightness and a little saturation move: an advertiser's teal stays teal
 * in both themes, it just stops being a neon on white. The accent needs the
 * most care — a colour chosen to glow on near-black is almost always too pale
 * to read as a CTA on near-white, so it is clamped into a band that works and
 * then contrast-checked.
 */
export function derivePalette(source: AdPalette, target: AdTheme): AdPalette {
  const bgSrc = toHsl(source.bgColor);
  const fgSrc = toHsl(source.fgColor);
  const accentSrc = toHsl(source.accentColor);

  const bg =
    target === "light"
      ? fromHsl({ ...bgSrc, s: Math.min(bgSrc.s, 0.18), l: 0.97, a: bgSrc.a })
      : fromHsl({ ...bgSrc, s: Math.min(bgSrc.s, 0.35), l: 0.06, a: bgSrc.a });

  const fg =
    target === "light"
      ? fromHsl({ ...fgSrc, s: Math.min(fgSrc.s, 0.25), l: 0.13, a: fgSrc.a })
      : fromHsl({ ...fgSrc, s: Math.min(fgSrc.s, 0.2), l: 0.93, a: fgSrc.a });

  // Saturation is floored so a washed-out accent still reads as a CTA — but
  // only when there is a hue to preserve. An achromatic accent (a grey, a
  // white) has an arbitrary hue of 0, and forcing saturation onto it invents a
  // red the advertiser never chose. Greys stay grey and get their contrast
  // from lightness alone.
  const accentSat = accentSrc.s < 0.12 ? accentSrc.s : Math.max(accentSrc.s, 0.45);
  const accent =
    target === "light"
      ? fromHsl({ ...accentSrc, s: accentSat, l: clamp(accentSrc.l, 0.28, 0.46), a: accentSrc.a })
      : fromHsl({ ...accentSrc, s: accentSat, l: clamp(accentSrc.l, 0.55, 0.72), a: accentSrc.a });

  return {
    bgColor: bg,
    fgColor: ensureContrast(fg, bg),
    // 3:1 is the WCAG threshold for large text and UI components, which is
    // exactly what a CTA chip is.
    accentColor: ensureContrast(accent, bg, 3),
  };
}

/**
 * Hairline border for a unit on `theme`.
 *
 * Every creative used to draw `rgba(255,255,255,.08)` — a white haze that is
 * invisible against a dark page and a grey smear against a light one.
 */
export function hairline(theme: AdTheme): string {
  return theme === "light" ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.08)";
}

/** The ink a readability gradient over hero imagery should be mixed from. */
export function overlayInk(theme: AdTheme): string {
  return theme === "light" ? "#ffffff" : "#070a10";
}

/** Text colour that sits legibly on top of hero imagery for this theme. */
export function overImageInk(theme: AdTheme): string {
  return theme === "light" ? "#10151b" : "#f4f7fb";
}
