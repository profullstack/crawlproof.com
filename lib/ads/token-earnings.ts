import type { SupabaseClient } from "@supabase/supabase-js";
import { dayAxis, type RangeTotals, type SlotTotals } from "./series";

export type TokenDelivery = {
  campaignTotals: { data: Map<string, RangeTotals>; failed: false };
  slotTotals: { data: Map<string, SlotTotals>; failed: false };
  daily: Array<{ date: string; spentCents: number; earnedCents: number }>;
};

type Row = Record<string, string | number>;
const n = (value: unknown) => Number(value) || 0;

/** An error is unavailable data, never a successful zero-filled response. */
export async function loadTokenDelivery(sb: SupabaseClient, ownerId: string, days: number): Promise<TokenDelivery> {
  const { data, error } = await sb.rpc("ad_token_earnings", { p_owner: ownerId, p_days: days });
  if (error || !data || !Array.isArray(data.campaigns) || !Array.isArray(data.slots) || !Array.isArray(data.daily)) {
    console.error("[ads] Token reporting failed", { code: error?.code ?? "invalid_response" });
    throw new Error("Ad reporting is temporarily unavailable. Please retry.");
  }
  const campaignTotals = new Map<string, RangeTotals>();
  for (const row of data.campaigns as Row[]) {
    campaignTotals.set(String(row.campaign_id), {
      impressions: n(row.impressions), freeImpressions: n(row.free_impressions),
      clicks: n(row.clicks), freeClicks: n(row.free_clicks), spentCents: n(row.spent_cents),
    });
  }
  const slotTotals = new Map<string, SlotTotals>();
  for (const row of data.slots as Row[]) {
    slotTotals.set(String(row.slot_id), {
      impressions: n(row.impressions), freeImpressions: n(row.free_impressions),
      clicks: n(row.clicks), freeClicks: n(row.free_clicks),
      invalidClicks: n(row.invalid_clicks), earnedCents: n(row.earned_cents),
    });
  }
  const money = new Map<string, Row>((data.daily as Row[]).map((r) => [String(r.date), r]));
  return {
    campaignTotals: { data: campaignTotals, failed: false },
    slotTotals: { data: slotTotals, failed: false },
    daily: dayAxis(days).map((date) => ({ date, spentCents: n(money.get(date)?.spentCents), earnedCents: n(money.get(date)?.earnedCents) })),
  };
}
