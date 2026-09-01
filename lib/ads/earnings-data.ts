import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deliveredClicks,
  deliveredImpressions,
  getCampaignDailySeries,
  getCampaignTotalsSince,
  getSlotDailySeries,
  getSlotTotalsSince,
  mergeMoneySeries,
  sinceForDays,
  EMPTY_SLOT_TOTALS,
  EMPTY_TOTALS,
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
  /**
   * Money is a balance and delivery is a rate, so they answer different
   * questions and cannot share a window.
   *
   * `spentCents` / `earnedCents` / `withdrawnCents` / `availableCents` /
   * `netCents` are ALL TIME: "available to withdraw" is lifetime earnings minus
   * lifetime payouts, and clipping it to the last 30 days would under-report a
   * real balance the account is owed.
   *
   * Everything else — the impression and click totals, and every row in
   * `campaigns` and `slots` — covers `rangeDays`, which is what the page and
   * the PDF header both promise.
   */
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
    /**
     * Clicks recorded in the range and deliberately not counted as delivery:
     * bot, duplicate, forged, or against a campaign that was not servable.
     * Reported so they are visible somewhere; kept out of pubClicks so a bot
     * run cannot flatter the CTR.
     */
    invalidClicks: number;
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
type Project = { id: string; name: string };
type Slot = { id: string; project_id: string; status: string };
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
  // The window the tables and the impression/click totals cover. Money is not
  // scoped to it — see the note on EarningsModel.totals.
  const since = sinceForDays(days);

  const [
    { data: campaignsData },
    campaignTotals,
    { data: projectsData },
    { data: slotsData },
    slotTotals,
    { data: ledgerData },
    { data: payoutsData },
  ] = await Promise.all([
    supabase.from("ad_campaigns").select("id, name, status, total_spent_cents, spend_today_cents, spend_date"),
    // Not ad_campaign_stats / ad_slot_stats: those views are lifetime and count
    // only tier 'paid', so on a network running entirely on free backfill they
    // report zero for every campaign and every site. The RPCs take a window and
    // return both tiers.
    getCampaignTotalsSince(supabase, since),
    // Monetization is owner-only (payouts go to the slot owner), like /ads/slots.
    supabase.from("projects").select("id, name").eq("owner_id", userId),
    supabase.from("ad_slots").select("id, project_id, status"),
    getSlotTotalsSince(supabase, since),
    supabase.from("ad_ledger").select("slot_id, amount_cents").eq("kind", "publisher_accrual"),
    supabase
      .from("ad_payouts")
      .select("amount_cents, currency, status, tx_hash, created_at")
      .order("created_at", { ascending: false }),
  ]);

  const campaigns = (campaignsData as CampaignRow[]) ?? [];
  const projectsById = new Map<string, Project>();
  for (const p of (projectsData as Project[]) ?? []) projectsById.set(p.id, p);
  // Only slots for projects the user owns (mirrors the /ads/slots scoping).
  const slots = ((slotsData as Slot[]) ?? []).filter((s) => projectsById.has(s.project_id));
  const earnedBySlot = new Map<string, number>();
  for (const row of (ledgerData as LedgerRow[]) ?? []) {
    if (row.slot_id) earnedBySlot.set(row.slot_id, (earnedBySlot.get(row.slot_id) ?? 0) + (row.amount_cents ?? 0));
  }
  const payouts = (payoutsData as PayoutRow[]) ?? [];

  const todayUtc = new Date().toISOString().slice(0, 10);

  // Delivery is paid inventory plus free backfill, the same measure the
  // campaigns dashboard reports. A free-tier impression is still an impression;
  // what it is not is revenue, and the money columns say so on their own.
  const campaignRows: EarningsCampaignRow[] = campaigns.map((c) => {
    const s = campaignTotals.get(c.id) ?? EMPTY_TOTALS;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      impressions: deliveredImpressions(s),
      clicks: deliveredClicks(s),
      spentCents: s.spentCents,
    };
  });

  const slotRows: EarningsSlotRow[] = slots.map((sl) => {
    const s = slotTotals.get(sl.id) ?? EMPTY_SLOT_TOTALS;
    return {
      id: sl.id,
      name: projectsById.get(sl.project_id)?.name ?? "Site",
      status: sl.status,
      impressions: deliveredImpressions(s),
      clicks: deliveredClicks(s),
      earnedCents: s.earnedCents,
    };
  });

  // Lifetime, deliberately — these feed the balance tiles. `availableCents` is
  // lifetime earnings minus lifetime payouts, so scoping either side to the
  // range would under-report money the account is actually owed. Read them from
  // the campaign row and the ledger rather than from campaignRows/slotRows,
  // whose money columns now cover the range instead.
  const spentCents = campaigns.reduce((a, c) => a + (c.total_spent_cents ?? 0), 0);
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
      invalidClicks: slots.reduce(
        (a, sl) => a + (slotTotals.get(sl.id)?.invalidClicks ?? 0),
        0,
      ),
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
