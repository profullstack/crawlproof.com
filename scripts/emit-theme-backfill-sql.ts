#!/usr/bin/env -S npx tsx
//
// Emit the SQL the backfill would run, for the case where the box has no
// Supabase credentials and the writes have to go over a privileged SQL channel
// instead. Takes a JSON array of [bg, fg, accent] trios on argv[2].
//
// It calls the same derivePalette/themeOfBackground the renderer uses, so the
// statements it prints and a later run of backfill-ad-themes.ts agree exactly.

import { readFileSync } from "node:fs";
import { contrastRatio, derivePalette, themeOfBackground } from "../lib/ads/theme";

const trios: [string, string, string][] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

let movedToLight = 0;
const rows: string[] = [];

for (const [bg, fg, accent] of trios) {
  const primary = { bgColor: bg, fgColor: fg, accentColor: accent };

  // Both cases are expressed as the same 9-column row so the whole backfill is
  // one atomic statement: the dark trio to end up with, and the light trio to
  // end up with. For an already-dark creative the dark trio is unchanged.
  let dark = primary;
  let light;
  if (themeOfBackground(bg) === "light") {
    // The stored trio is actually a LIGHT palette. It moves into the light
    // columns and gets a derived dark counterpart, rather than being handed a
    // "light variant" that is already light and a dark slot that glares.
    dark = derivePalette(primary, "dark");
    light = primary;
    movedToLight++;
  } else {
    light = derivePalette(primary, "light");
  }

  // Only palettes WE derived are asserted on. A pass-through primary that
  // already fails contrast is the advertiser's own choice, and quietly
  // rewriting their brand colours is not what a theme backfill is for — it is
  // reported and left alone.
  if (light !== primary) check(light.fgColor, light.bgColor, `${bg} -> light`);
  if (dark !== primary) check(dark.fgColor, dark.bgColor, `${bg} -> dark`);
  else note(primary.fgColor, primary.bgColor, bg);
  rows.push(
    `(${[bg, fg, accent, dark.bgColor, dark.fgColor, dark.accentColor, light.bgColor, light.fgColor, light.accentColor].map(q).join(",")})`,
  );
}

const out = [
  "update ad_creatives c set",
  "  bg_color = v.dbg, fg_color = v.dfg, accent_color = v.dac,",
  "  light_bg_color = v.lbg, light_fg_color = v.lfg, light_accent_color = v.lac",
  "from (values",
  rows.join(",\n"),
  ") as v(bg, fg, ac, dbg, dfg, dac, lbg, lfg, lac)",
  "where c.bg_color = v.bg and c.fg_color = v.fg and c.accent_color = v.ac",
  "  and c.light_bg_color is null;",
];

function check(fg: string, bg: string, label: string): void {
  const ratio = contrastRatio(fg, bg);
  if (ratio < 4.5) {
    console.error(`-- WARNING: derived ${label} text contrast ${ratio.toFixed(2)} below 4.5`);
    process.exitCode = 1;
  }
}

/** A pre-existing palette we are leaving alone, flagged for the operator. */
function note(fg: string, bg: string, label: string): void {
  const ratio = contrastRatio(fg, bg);
  if (ratio < 4.5) {
    console.error(`-- NOTE: existing palette ${label} already at ${ratio.toFixed(2)} (left as-is)`);
  }
}

console.error(`-- ${trios.length} trios, ${movedToLight} had a light primary palette (moved)`);
console.log(out.join("\n"));
