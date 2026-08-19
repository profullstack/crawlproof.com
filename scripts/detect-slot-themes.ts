#!/usr/bin/env -S npx tsx
//
// Companion to backfill-ad-themes.ts for a box with no Supabase credentials:
// takes a JSON array of {id, name, url} on argv[2], reads each publisher's
// site, and prints the verdicts plus the SQL to apply them.
//
// Same detectSiteTheme the backfill uses, so the two agree.

import { readFileSync } from "node:fs";
import { detectSiteTheme } from "../lib/ads/siteTheme";

type Slot = { id: string; name: string | null; url: string | null };
const slots: Slot[] = JSON.parse(readFileSync(process.argv[2], "utf8"));

const byTheme: Record<string, string[]> = { light: [], dark: [] };

for (const s of slots) {
  if (!s.url) {
    console.error(`${(s.name ?? s.id).padEnd(30)} no url — left auto`);
    continue;
  }
  const v = await detectSiteTheme(s.url);
  console.error(`${(s.name ?? s.id).padEnd(30)} ${String(v.theme ?? "auto").padEnd(6)} ${v.reason}`);
  if (v.theme) byTheme[v.theme].push(s.id);
}

for (const theme of ["light", "dark"]) {
  const ids = byTheme[theme];
  if (!ids.length) continue;
  console.log(
    `update ad_slots set theme = '${theme}' where id in (${ids.map((i) => `'${i}'`).join(",")});`,
  );
}
console.error(`\nlight: ${byTheme.light.length}  dark: ${byTheme.dark.length}`);
