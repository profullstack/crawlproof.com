// Backfill the editorial summaries for campaigns that predate them.
//
//   npx tsx scripts/backfill-ad-summaries.ts --env ~/crawlproof-env-backup.txt --dry-run
//   npx tsx scripts/backfill-ad-summaries.ts --env ~/crawlproof-env-backup.txt --limit 5
//   npx tsx scripts/backfill-ad-summaries.ts --env ~/crawlproof-env-backup.txt
//
// TypeScript rather than the .mjs the other scripts use, and run through tsx,
// so it can import `generateAdSummary` from lib/ads/creative — the same prompt
// the live generator uses. Reimplementing the prompt here in plain JS would
// mean backfilled prose reading differently from freshly generated prose, with
// nothing to say why.
//
// Safe to re-run. It only selects campaigns that still need prose, so an
// interrupted pass continues where it stopped, and a campaign whose summary was
// written by hand afterwards is left alone.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- environment ------------------------------------------------------------
// Loaded before importing anything that reads `env`, because lib/env captures
// process.env at module scope: a top-level import of creative.ts would see an
// empty key and construct no client at all.
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);

const envPath = flag("env") ?? `${process.env.HOME}/crawlproof-env-backup-2026-07-28.txt`;
const dryRun = has("dry-run");
const limit = Number(flag("limit") ?? "0") || 0;
/** How many sites to read and summarise at once. */
const CONCURRENCY = Number(flag("concurrency") ?? "3") || 3;

for (const [k, v] of Object.entries(readEnvFile(envPath))) {
  if (!process.env[k]) process.env[k] = v;
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        }),
    );
  } catch (err) {
    console.error(`Could not read env file ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Imported after the env is populated, for the reason above.
const { generateAdSummary } = await import("../lib/ads/creative");

// --- database ---------------------------------------------------------------

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

type Row = {
  id: string;
  name: string;
  destination_url: string;
  destination_domain: string | null;
  summary_short: string | null;
  summary_domain: string | null;
};

// Everything without usable prose: never generated, or generated for a domain
// the campaign no longer points at (serving treats that as absent, so it is
// exactly as unhelpful as never having had one).
const { data, error } = await sb
  .from("ad_campaigns")
  .select("id, name, destination_url, destination_domain, summary_short, summary_domain")
  .order("created_at", { ascending: true });

if (error) {
  console.error("Could not list campaigns:", error.message);
  process.exit(1);
}

const stale = (r: Row) =>
  !r.summary_short ||
  !r.summary_domain ||
  (r.destination_domain ?? "").toLowerCase() !== r.summary_domain.toLowerCase();

let todo = (data as Row[]).filter(stale);
if (limit > 0) todo = todo.slice(0, limit);

console.log(
  `${data.length} campaigns, ${(data as Row[]).filter(stale).length} need prose` +
    (limit > 0 ? `, running the first ${todo.length}` : "") +
    (dryRun ? " (DRY RUN — nothing will be written)" : ""),
);
if (todo.length === 0) process.exit(0);

// --- the pass ---------------------------------------------------------------

let done = 0;
let written = 0;
let failed = 0;
const failures: Array<{ name: string; url: string; why: string }> = [];

async function one(row: Row): Promise<void> {
  const n = ++done;
  const label = `[${n}/${todo.length}] ${row.name.slice(0, 40)}`;
  try {
    const { summary, provider } = await generateAdSummary(row.destination_url);

    // generateAdSummary returns empty prose for a page it could not read, and
    // for prose that described the fetch rather than the product. Both are a
    // deliberate "no summary" rather than a failure, and the provider string
    // says which — but either way there is nothing to store.
    if (!summary.short && !summary.long) {
      throw new Error(
        provider.startsWith("skipped:") || provider.startsWith("rejected:")
          ? provider
          : "model returned nothing usable",
      );
    }
    // The same guard the server action applies: prose is only stored when it
    // describes where the campaign actually points. A redirect to another host
    // is the usual way this trips.
    const points = (row.destination_domain ?? "").toLowerCase();
    if (points && summary.domain && summary.domain !== points) {
      throw new Error(`resolved to ${summary.domain}, campaign points at ${points}`);
    }

    if (dryRun) {
      console.log(`${label} — would write (${provider})`);
      console.log(`    short: ${summary.short.slice(0, 110)}`);
      console.log(`    long : ${summary.long.split("\n\n").length} paragraphs`);
      return;
    }

    const { error: uErr } = await sb
      .from("ad_campaigns")
      .update({
        summary_short: summary.short || null,
        summary_long: summary.long || null,
        summary_domain: summary.domain || points || null,
        summary_generated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (uErr) throw new Error(uErr.message);

    written += 1;
    console.log(`${label} — ok (${provider}, ${summary.long.split("\n\n").length}¶)`);
  } catch (err) {
    failed += 1;
    const why = err instanceof Error ? err.message : String(err);
    failures.push({ name: row.name, url: row.destination_url, why });
    // A dead or hostile site is ordinary in a list this old; it must not stop
    // the pass, and the campaign simply keeps falling back to its short body.
    console.log(`${label} — SKIP: ${why.slice(0, 120)}`);
  }
}

// A small fixed pool. These calls each fetch a third-party site and then hit an
// LLM, so the limit is politeness to the sites as much as rate-limit safety.
const queue = [...todo];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      await one(row);
    }
  }),
);

console.log(
  `\nDone. ${written} written, ${failed} skipped, ${todo.length} attempted${dryRun ? " (dry run)" : ""}.`,
);
if (failures.length > 0) {
  console.log("\nSkipped:");
  for (const f of failures) console.log(`  ${f.name.slice(0, 40)} — ${f.url} — ${f.why.slice(0, 90)}`);
}
