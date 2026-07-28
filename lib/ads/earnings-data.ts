import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCampaignDailySeries,
  getSlotDailySeries,
  mergeMoneySeries,
} from "./series";

// Unified money model for one account — a single user is both an advertiser
// (ad_campaigns.owner_id) and a publisher (ad_slots.owner_id), so the earnings
// page shows BOTH spend and earnings. Everything is RLS-scoped to the caller;
// pass a request-scoped Supabase client whose auth.uid() is the account.

export type MoneyDailyPoint = { date: string; spentCents: number; earnedCents: number };

export type EarningsCampaignRow = {
  id: string;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  spentCents: number;
};

export type EarningsSlotRow = {
  id: string;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  earnedCents: number;
};

export type EarningsPayoutRow = {
  amountCents: number;
  currency: string;
  status: string;
  txHash: string | null;
  createdAt: string;
};

export type EarningsModel = {
  rangeDays: number;
  totals: {
    spentCents: number;
    earnedCents: number;
    netCents: number;
    availableCents: number;
    withdrawnCents: number;
    spendTodayCents: number;
    earnedTodayCents: number;
    advImpressions: number;
    advClicks: number;
    pubImpressions: number;
    pubClicks: number;
  };
  campaigns: EarningsCampaignRow[];
  slots: EarningsSlotRow[];
  payouts: EarningsPayoutRow[];
  daily: MoneyDailyPoint[];
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  total_spent_cents: number | null;
  spend_today_cents: number | null;
  spend_date: string | null;
};
type CampaignStat = { campaign_id: string; impressions: number; clicks: number; spent_cents: number };
type Project = { id: string; name: string };
type Slot = { id: string; project_id: string; status: string };
type SlotStat = { slot_id: string; impressions: number; clicks: number; earned_cents: number };
type LedgerRow = { slot_id: string | null; amount_cents: number | null };
type PayoutRow = {
  amount_cents: number | null;
  currency: string;
  status: string;
  tx_hash: string | null;
  created_at: string;
};

export async function loadEarnings(
  supabase: SupabaseClient,
  userId: string,
  days = 30,
): Promise<EarningsModel> {
  const [
    { data: campaignsData },
    { data: campaignStatsData },
    { data: projectsData },
    { data: slotsData },
    { data: slotStatsData },
    { data: ledgerData },
    { data: payoutsData },
  ] = await Promise.all([
    supabase.from("ad_campaigns").select("id, name, status, total_spent_cents, spend_today_cents, spend_date"),
    supabase.from("ad_campaign_stats").select("campaign_id, impressions, clicks, spent_cents"),
    // Monetization is owner-only (payouts go to the slot owner), like /ads/slots.
    supabase.from("projects").select("id, name").eq("owner_id", userId),
    supabase.from("ad_slots").select("id, project_id, status"),
    supabase.from("ad_slot_stats").select("slot_id, impressions, clicks, earned_cents"),
    supabase.from("ad_ledger").select("slot_id, amount_cents").eq("kind", "publisher_accrual"),
    supabase
      .from("ad_payouts")
      .select("amount_cents, currency, status, tx_hash, created_at")
      .order("created_at", { ascending: false }),
  ]);

  const campaigns = (campaignsData as CampaignRow[]) ?? [];
  const campaignStats = new Map<string, CampaignStat>();
  for (const s of (campaignStatsData as CampaignStat[]) ?? []) campaignStats.set(s.campaign_id, s);
  const projectsById = new Map<string, Project>();
  for (const p of (projectsData as Project[]) ?? []) projectsById.set(p.id, p);
  // Only slots for projects the user owns (mirrors the /ads/slots scoping).
  const slots = ((slotsData as Slot[]) ?? []).filter((s) => projectsById.has(s.project_id));
  const slotStats = new Map<string, SlotStat>();
  for (const s of (slotStatsData as SlotStat[]) ?? []) slotStats.set(s.slot_id, s);
  const earnedBySlot = new Map<string, number>();
  for (const row of (ledgerData as LedgerRow[]) ?? []) {
    if (row.slot_id) earnedBySlot.set(row.slot_id, (earnedBySlot.get(row.slot_id) ?? 0) + (row.amount_cents ?? 0));
  }
  const payouts = (payoutsData as PayoutRow[]) ?? [];

  const todayUtc = new Date().toISOString().slice(0, 10);

  const campaignRows: EarningsCampaignRow[] = campaigns.map((c) => {
    const s = campaignStats.get(c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      impressions: s?.impressions ?? 0,
      clicks: s?.clicks ?? 0,
      spentCents: c.total_spent_cents ?? 0,
    };
  });

  const slotRows: EarningsSlotRow[] = slots.map((sl) => {
    const s = slotStats.get(sl.id);
    return {
      id: sl.id,
      name: projectsById.get(sl.project_id)?.name ?? "Site",
      status: sl.status,
      impressions: s?.impressions ?? 0,
      clicks: s?.clicks ?? 0,
      earnedCents: earnedBySlot.get(sl.id) ?? 0,
    };
  });

  const spentCents = campaignRows.reduce((a, c) => a + c.spentCents, 0);
  const earnedCents = [...earnedBySlot.values()].reduce((a, v) => a + v, 0);
  const withdrawnCents = payouts
    .filter((p) => p.status !== "failed")
    .reduce((a, p) => a + (p.amount_cents ?? 0), 0);
  const spendTodayCents = campaigns
    .filter((c) => c.spend_date === todayUtc)
    .reduce((a, c) => a + (c.spend_today_cents ?? 0), 0);

  // Daily series (spend from campaigns, earnings from slots), merged by day.
  const [campaignSeries, slotSeries] = await Promise.all([
    getCampaignDailySeries(supabase, campaignRows.map((c) => c.id), days),
    getSlotDailySeries(supabase, slotRows.map((s) => s.id), days),
  ]);
  const daily = mergeMoneySeries(campaignSeries, slotSeries, days);
  const earnedTodayCents = daily.length ? daily[daily.length - 1].earnedCents : 0;

  return {
    rangeDays: days,
    totals: {
      spentCents,
      earnedCents,
      netCents: earnedCents - spentCents,
      availableCents: Math.max(0, earnedCents - withdrawnCents),
      withdrawnCents,
      spendTodayCents,
      earnedTodayCents,
      advImpressions: campaignRows.reduce((a, c) => a + c.impressions, 0),
      advClicks: campaignRows.reduce((a, c) => a + c.clicks, 0),
      pubImpressions: slotRows.reduce((a, s) => a + s.impressions, 0),
      pubClicks: slotRows.reduce((a, s) => a + s.clicks, 0),
    },
    campaigns: campaignRows,
    slots: slotRows,
    payouts: payouts.map((p) => ({
      amountCents: p.amount_cents ?? 0,
      currency: p.currency,
      status: p.status,
      txHash: p.tx_hash,
      createdAt: p.created_at,
    })),
    daily,
  };
}

export function dollars(cents: number): string {
  const neg = cents < 0;
  return `${neg ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
