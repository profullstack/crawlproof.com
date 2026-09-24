// Queue a five-second pre-roll render for existing PRODUCT campaigns.
//
//   npx tsx scripts/backfill-ad-videos.ts --env ~/crawlproof-env-backup-2026-07-28.txt --dry-run
//   npx tsx scripts/backfill-ad-videos.ts --env ~/crawlproof-env-backup-2026-07-28.txt --limit 3
//   npx tsx scripts/backfill-ad-videos.ts --env ~/crawlproof-env-backup-2026-07-28.txt
//
// TypeScript through tsx, like backfill-ad-summaries, so it can call the same
// queueCampaignVideo the dashboard calls. Reimplementing the snapshot here
// would mean backfilled videos differing from freshly saved ones with nothing
// to explain why.
//
// Safe to re-run. Render jobs dedupe on a hash of the design, so a campaign
// that already has a job for its current copy is skipped rather than
// re-encoded, and an interrupted pass continues where it stopped.
//
// It never rewrites campaign copy and never changes campaign status: the only
// writes are the video creative row and its render job.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);

const envPath = flag("env") ?? `${process.env.HOME}/crawlproof-env-backup-2026-07-28.txt`;
const dryRun = has("dry-run");
const limit = Number(flag("limit") ?? "0") || 0;
/** Pause between queued campaigns, so a backfill does not spike the queue. */
const DELAY_MS = Number(flag("delay") ?? "150") || 150;

for (const [k, v] of Object.entries(readEnvFile(envPath))) {
  if (!process.env[k]) process.env[k] = v;
}

const { queueCampaignVideo } = await import("../lib/ads/video/jobs");
const { classifyCampaign } = await import("../lib/ads/video/classify");
type CampaignKind = "product" | "blog" | "social";

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type CampaignRow = {
  id: string;
  owner_id: string;
  name: string;
  status: string;
  destination_url: string;
  destination_domain: string | null;
};

const { data: campaigns, error } = await supabase
  .from("ad_campaigns")
  .select("id, owner_id, name, status, destination_url, destination_domain")
  // A rejected campaign must not gain new servable media.
  .neq("status", "rejected")
  .order("created_at", { ascending: true });

if (error) {
  console.error("Could not read campaigns:", error.message);
  process.exit(1);
}

const all = (campaigns ?? []) as CampaignRow[];
const tally: Record<CampaignKind, number> = { product: 0, blog: 0, social: 0 };
const products: CampaignRow[] = [];
for (const c of all) {
  const kind = classifyCampaign(c.destination_url);
  tally[kind]++;
  if (kind === "product") products.push(c);
}

console.log(
  `${all.length} campaigns: ${tally.product} product, ${tally.blog} blog, ${tally.social} social.`,
);

const targets = limit > 0 ? products.slice(0, limit) : products;
console.log(`${targets.length} to queue${dryRun ? " (dry run — nothing written)" : ""}.\n`);

let queued = 0;
let reused = 0;
let skipped = 0;
let failed = 0;

for (const [i, c] of targets.entries()) {
  const label = `${i + 1}/${targets.length} ${c.destination_url.slice(0, 70)}`;

  const { data: creatives } = await supabase
    .from("ad_creatives")
    .select("format, headline, cta_text, bg_color, fg_color, accent_color, font_family, logo_url, image_url")
    .eq("campaign_id", c.id)
    .neq("format", "video_preroll_5s")
    .neq("status", "rejected");

  const usable = (creatives ?? []).filter((r) => (r.headline ?? "").trim().length > 0);
  if (usable.length === 0) {
    console.log(`  skip  ${label} — no usable creative`);
    skipped++;
    continue;
  }

  if (dryRun) {
    console.log(`  would ${label}`);
    queued++;
    continue;
  }

  const handle = await queueCampaignVideo(supabase, {
    campaignId: c.id,
    ownerId: c.owner_id,
    domain: c.destination_domain ?? new URL(c.destination_url).hostname.replace(/^www\./, ""),
    creatives: usable.map((r) => ({
      format: r.format,
      headline: r.headline ?? "",
      ctaText: r.cta_text ?? "",
      bgColor: r.bg_color,
      fgColor: r.fg_color,
      accentColor: r.accent_color,
      fontFamily: r.font_family,
      logoUrl: r.logo_url,
      imageUrl: r.image_url,
    })),
    // A backfill is not an edit. Bumping the revision would invalidate media
    // that a previous pass already rendered for the same unchanged design.
    bumpRevision: false,
  });

  if (!handle) {
    console.log(`  FAIL  ${label}`);
    failed++;
  } else if (handle.reused) {
    console.log(`  have  ${label} — job ${handle.jobId} (${handle.state})`);
    reused++;
  } else {
    console.log(`  queue ${label} — job ${handle.jobId}${handle.enqueued ? "" : " (row only; sweep will schedule)"}`);
    queued++;
  }

  if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
}

console.log(
  `\nDone. queued=${queued} already-had=${reused} skipped=${skipped} failed=${failed}`,
);
