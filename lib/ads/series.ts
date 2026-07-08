import type { SupabaseClient } from "@supabase/supabase-js";

export type CampaignDailyPoint = {
  /** UTC calendar day, YYYY-MM-DD */
  date: string;
  impressions: number;
  clicks: number;
  spentCents: number;
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Build a zero-filled list of the last `days` UTC calendar days, oldest first. */
function dayAxis(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Per-campaign daily impressions / clicks / spend for the last `days`, built by
 * aggregating raw ad_impressions + ad_clicks rows in JS. RLS lets a campaign
 * owner read their own event rows (see 20260707140000_ad_serving.sql), so no
 * extra view/RPC — and no prod migration — is needed.
 */
export async function getCampaignDailySeries(
  supabase: SupabaseClient,
  campaignIds: string[],
  days = 30,
): Promise<Map<string, CampaignDailyPoint[]>> {
  const axis = dayAxis(days);
  const result = new Map<string, CampaignDailyPoint[]>();
  const emptyFor = () =>
    axis.map((date) => ({ date, impressions: 0, clicks: 0, spentCents: 0 }));
  for (const id of campaignIds) result.set(id, emptyFor());
  if (campaignIds.length === 0) return result;

  // index[campaignId][date] -> point, for O(1) accumulation
  const index = new Map<string, Map<string, CampaignDailyPoint>>();
  for (const id of campaignIds) {
    const byDay = new Map<string, CampaignDailyPoint>();
    for (const p of result.get(id)!) byDay.set(p.date, p);
    index.set(id, byDay);
  }

  const since = new Date(
    Date.now() - (days - 1) * 86_400_000,
  );
  const sinceStart = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()),
  ).toISOString();

  const [{ data: imps }, { data: clicks }] = await Promise.all([
    supabase
      .from("ad_impressions")
      .select("campaign_id, created_at")
      .in("campaign_id", campaignIds)
      .gte("created_at", sinceStart),
    supabase
      .from("ad_clicks")
      .select("campaign_id, created_at, charged_cents, valid")
      .in("campaign_id", campaignIds)
      .eq("valid", true)
      .gte("created_at", sinceStart),
  ]);

  for (const row of (imps as { campaign_id: string; created_at: string }[]) ?? []) {
    const point = index.get(row.campaign_id)?.get(dayKey(row.created_at));
    if (point) point.impressions += 1;
  }
  for (const row of (clicks as {
    campaign_id: string;
    created_at: string;
    charged_cents: number | null;
  }[]) ?? []) {
    const point = index.get(row.campaign_id)?.get(dayKey(row.created_at));
    if (point) {
      point.clicks += 1;
      point.spentCents += row.charged_cents ?? 0;
    }
  }

  return result;
}
