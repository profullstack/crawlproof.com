// /api/ads/v1/earnings — the account's ad money and delivery, for a token caller.
//
//   GET ?days=7|30|90|365
//
// The same model /dashboard/ads/earnings renders, for something holding an API
// token. It exists because the alternative for a client that wants fleet totals
// is one /campaigns/[id] request per campaign, and the account is past 170 of
// them — see `crawlproof dashboard`, which polls this on a timer.
//
// Same auth as the rest of /api/ads/v1/*: `Authorization: Bearer crp_…`.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { loadEarnings } from "@/lib/ads/earnings-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90, 365];

/** An unknown window falls back to 30 rather than reaching the query planner. */
export function parseDays(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_DAYS.includes(n) ? n : 30;
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const days = parseDays(req.nextUrl.searchParams.get("days"));
  const sb = serviceClient();
  // The service client has no RLS. loadEarnings filters every table by
  // owner_id itself, which is what makes passing it here safe.
  const model = await loadEarnings(sb, auth.userId, days);

  // The windowed delivery figures come from RPCs that are `security definer`
  // and filter on `auth.uid()`. A service client has no auth.uid(), so they
  // return nothing and every impression count arrives as a confident zero.
  // The stats views are `security_invoker` and granted to service_role, so
  // they can be read directly. They are lifetime rather than windowed, which
  // is why this only replaces figures that came back empty, and why the answer
  // says which it gave you.
  const delivery = await lifetimeDelivery(sb, model);
  return NextResponse.json({ ...model, ...delivery });
}

type StatsRow = {
  impressions: number | null;
  free_impressions: number | null;
  clicks: number | null;
  free_clicks: number | null;
};

/**
 * What the stats views actually mean, which is not what the column names
 * suggest and is worth writing down once:
 *
 *   impressions       paid tier, non-duplicate
 *   free_impressions  free tier, non-duplicate  -> delivery is the SUM of both
 *   clicks            **valid** clicks, either tier -> delivery is this alone
 *   free_clicks       free tier and **not valid** -> fraud/duplicate, NOT delivery
 *
 * So impressions add up and clicks do not. Adding `free_clicks` into clicks
 * would fold invalid clicks into the CTR, which is the one number a click
 * fraud problem would show up in.
 */
const sum = (rows: StatsRow[], key: keyof StatsRow) =>
  rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

/**
 * Read a stats view for a list of ids, in chunks.
 *
 * PostgREST puts `in.(…)` in the query string, and this account is past 180
 * campaigns, so one call is a 7KB URL that comes back empty rather than
 * erroring. That empty answer is exactly what a network with no delivery looks
 * like, which is how it went unnoticed.
 */
async function readStats(
  sb: ReturnType<typeof serviceClient>,
  view: "ad_campaign_stats" | "ad_slot_stats",
  key: "campaign_id" | "slot_id",
  ids: string[],
): Promise<{ rows: StatsRow[]; failed: boolean }> {
  const rows: StatsRow[] = [];
  let failed = false;
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await sb
      .from(view)
      .select("impressions, free_impressions, clicks, free_clicks")
      .in(key, ids.slice(i, i + CHUNK));
    if (error) failed = true;
    else rows.push(...((data ?? []) as StatsRow[]));
  }
  return { rows, failed };
}

async function lifetimeDelivery(
  sb: ReturnType<typeof serviceClient>,
  model: Awaited<ReturnType<typeof loadEarnings>>,
) {
  const t = model.totals;
  const empty = !t.advImpressions && !t.advClicks && !t.pubImpressions && !t.pubClicks;
  if (!empty) return { deliveryWindow: "range" as const };

  const campaignIds = model.campaigns.map((c) => c.id);
  const slotIds = model.slots.map((s) => s.id);
  if (!campaignIds.length && !slotIds.length) return { deliveryWindow: "range" as const };

  const [c, s] = await Promise.all([
    readStats(sb, "ad_campaign_stats", "campaign_id", campaignIds),
    readStats(sb, "ad_slot_stats", "slot_id", slotIds),
  ]);

  return {
    deliveryWindow: "lifetime" as const,
    statsUnavailable: model.statsUnavailable || c.failed || s.failed,
    totals: {
      ...t,
      advImpressions: sum(c.rows, "impressions") + sum(c.rows, "free_impressions"),
      advClicks: sum(c.rows, "clicks"),
      advFreeImpressions: sum(c.rows, "free_impressions"),
      advPaidImpressions: sum(c.rows, "impressions"),
      pubImpressions: sum(s.rows, "impressions") + sum(s.rows, "free_impressions"),
      pubClicks: sum(s.rows, "clicks"),
      pubFreeImpressions: sum(s.rows, "free_impressions"),
      pubPaidImpressions: sum(s.rows, "impressions"),
      invalidClicks: sum(c.rows, "free_clicks"),
    },
  };
}
