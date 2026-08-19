#!/usr/bin/env -S npx tsx
//
// Backfill light/dark variants for every ad creative, and a default polarity
// for every ad slot. No human in the loop: colours are derived from the
// creative's own palette, and each slot's default is read off the publisher's
// live site.
//
// Usage:
//   npx tsx scripts/backfill-ad-themes.ts --dry-run     # show, change nothing
//   npx tsx scripts/backfill-ad-themes.ts               # creatives + slots
//   npx tsx scripts/backfill-ad-themes.ts --creatives   # just creatives
//   npx tsx scripts/backfill-ad-themes.ts --slots       # just slots
//   npx tsx scripts/backfill-ad-themes.ts --slots --force   # re-decide slots
//                                                            already set
//
// Idempotent. Creatives that already carry a light trio are skipped, and so
// are slots whose theme is not 'auto' (unless --force). Safe to re-run after
// adding advertisers.
//
// Colours come from lib/ads/theme.ts — the same module the renderer uses — so
// a backfilled palette and a freshly generated one can never disagree.

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { derivePalette, themeOfBackground, type AdPalette } from "../lib/ads/theme";
import { detectSiteTheme } from "../lib/ads/siteTheme";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const only = {
  creatives: argv.includes("--creatives"),
  slots: argv.includes("--slots"),
};
// Neither flag given → do both.
const doCreatives = only.creatives || !only.slots;
const doSlots = only.slots || !only.creatives;

function loadEnv(): Record<string, string> {
  // Prefer a real environment (Railway, CI); fall back to the checkout's .env.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env as Record<string, string>;
  }
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const parsed = Object.fromEntries(
      raw
        .split("\n")
        .filter((l) => l.trim() && !l.trimStart().startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
    return { ...parsed, ...process.env } as Record<string, string>;
  } catch {
    return process.env as Record<string, string>;
  }
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

type CreativeRow = {
  id: string;
  format: string;
  headline: string;
  bg_color: string;
  fg_color: string;
  accent_color: string;
  light_bg_color: string | null;
  light_fg_color: string | null;
  light_accent_color: string | null;
};

/**
 * What to write for one creative.
 *
 * The stored trio is *documented* as the dark palette, but it was never
 * enforced — an advertiser could always pick a white background. So the
 * polarity is measured rather than assumed: a creative whose primary palette
 * is actually light has it moved into the light columns and gets a derived
 * dark one, instead of being handed a "light" variant that is already light
 * and a dark slot that glares.
 */
function planCreative(r: CreativeRow): { patch: Record<string, string>; note: string } | null {
  if (r.light_bg_color && r.light_fg_color && r.light_accent_color) return null;

  const primary: AdPalette = {
    bgColor: r.bg_color,
    fgColor: r.fg_color,
    accentColor: r.accent_color,
  };

  if (themeOfBackground(primary.bgColor) === "light") {
    const dark = derivePalette(primary, "dark");
    return {
      patch: {
        bg_color: dark.bgColor,
        fg_color: dark.fgColor,
        accent_color: dark.accentColor,
        light_bg_color: primary.bgColor,
        light_fg_color: primary.fgColor,
        light_accent_color: primary.accentColor,
      },
      note: `primary was LIGHT (${primary.bgColor}) → moved to light_*, derived dark ${dark.bgColor}`,
    };
  }

  const light = derivePalette(primary, "light");
  return {
    patch: {
      light_bg_color: light.bgColor,
      light_fg_color: light.fgColor,
      light_accent_color: light.accentColor,
    },
    note: `dark ${primary.bgColor} → derived light ${light.bgColor}`,
  };
}

async function backfillCreatives(): Promise<void> {
  const { data, error } = await sb
    .from("ad_creatives")
    .select("id, format, headline, bg_color, fg_color, accent_color, light_bg_color, light_fg_color, light_accent_color")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("read ad_creatives failed:", error.message);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as CreativeRow[];
  let changed = 0;
  let skipped = 0;

  for (const r of rows) {
    const plan = planCreative(r);
    if (!plan) {
      skipped++;
      continue;
    }
    const label = `${r.format.padEnd(15)} ${(r.headline || "").slice(0, 32).padEnd(32)}`;
    if (DRY) {
      console.log(`  would update ${label} ${plan.note}`);
      changed++;
      continue;
    }
    const { error: uErr } = await sb.from("ad_creatives").update(plan.patch).eq("id", r.id);
    if (uErr) {
      console.error(`  FAILED ${r.id}: ${uErr.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  updated ${label} ${plan.note}`);
    changed++;
  }

  console.log(
    `creatives: ${changed} ${DRY ? "would change" : "updated"}, ${skipped} already had a light palette, ${rows.length} total`,
  );
}

type SlotRow = {
  id: string;
  theme: string | null;
  status: string;
  projects: { name: string | null; url: string | null } | { name: string | null; url: string | null }[] | null;
};

async function backfillSlots(): Promise<void> {
  const { data, error } = await sb
    .from("ad_slots")
    .select("id, theme, status, projects(name, url)")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("read ad_slots failed:", error.message);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as unknown as SlotRow[];
  let changed = 0;
  let skipped = 0;
  let unknown = 0;

  for (const r of rows) {
    if (!FORCE && r.theme && r.theme !== "auto") {
      skipped++;
      continue;
    }
    const project = Array.isArray(r.projects) ? r.projects[0] : r.projects;
    const site = project?.url;
    const label = (project?.name ?? r.id).padEnd(28);
    if (!site) {
      console.log(`  ${label} no project url — left as auto`);
      unknown++;
      continue;
    }

    const verdict = await detectSiteTheme(site);
    if (!verdict.theme) {
      console.log(`  ${label} ${site} → undecided (${verdict.reason}) — left as auto`);
      unknown++;
      continue;
    }
    if (r.theme === verdict.theme) {
      skipped++;
      continue;
    }
    if (DRY) {
      console.log(`  would set ${label} ${verdict.theme.padEnd(5)} (${verdict.reason})`);
      changed++;
      continue;
    }
    const { error: uErr } = await sb.from("ad_slots").update({ theme: verdict.theme }).eq("id", r.id);
    if (uErr) {
      console.error(`  FAILED ${r.id}: ${uErr.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  set ${label} ${verdict.theme.padEnd(5)} (${verdict.reason})`);
    changed++;
  }

  console.log(
    `slots: ${changed} ${DRY ? "would change" : "updated"}, ${skipped} already decided, ${unknown} undecided, ${rows.length} total`,
  );
}

console.log(DRY ? "DRY RUN — nothing will be written\n" : "");
if (doCreatives) {
  console.log("== creatives ==");
  await backfillCreatives();
}
if (doSlots) {
  console.log("\n== slots ==");
  await backfillSlots();
}
