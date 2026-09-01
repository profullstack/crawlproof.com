import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { fetchSupportedTokens } from "@/lib/coinpay-tokens";
import { SlotManager } from "@/components/ads/slot-manager";
import { StatsUnavailable } from "@/components/ads/stats-unavailable";
import {
  deliveredClicks,
  deliveredImpressions,
  getSlotTotalsSince,
  type SlotTotals,
} from "@/lib/ads/series";

// Fallback coins when CoinPay's supported-coins endpoint is unavailable, so the
// payout dropdown is never empty. Codes match what /payments+/payouts expect.
const FALLBACK_COINS = [
  { code: "usdc_pol", symbol: "USDC", name: "USD Coin (Polygon)", chain: "Polygon" },
  { code: "usdc_eth", symbol: "USDC", name: "USD Coin (Ethereum)", chain: "Ethereum" },
  { code: "usdt_pol", symbol: "USDT", name: "Tether (Polygon)", chain: "Polygon" },
  { code: "btc", symbol: "BTC", name: "Bitcoin", chain: "Bitcoin" },
  { code: "eth", symbol: "ETH", name: "Ethereum", chain: "Ethereum" },
  { code: "sol", symbol: "SOL", name: "Solana", chain: "Solana" },
];

export const metadata = { title: "Monetize your site" };

type Project = { id: string; name: string; url: string };
type Slot = {
  id: string;
  project_id: string;
  status: string;
  payout_address: string | null;
  payout_currency: string | null;
};
type Payout = {
  id: string;
  slot_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  tx_hash: string | null;
  created_at: string;
};

export default async function SlotsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let projects: Project[] = [];
  let slots: Slot[] = [];
  const earnedBySlot = new Map<string, number>();
  const withdrawnBySlot = new Map<string, number>();
  const payoutsBySlot = new Map<string, Payout[]>();
  let statsBySlot = new Map<string, SlotTotals>();
  // Distinguishes "no earnings yet" from "could not read them".
  let statsFailed = false;
  if (user) {
    const [{ data: p }, { data: s }, { data: ledger }, { data: payouts }, slotStats] =
      await Promise.all([
        // Monetization is owner-only: you earn from a slot, so only list projects
        // you OWN — not org/member-shared ones the broad RLS would also return.
        supabase
          .from("projects")
          .select("id, name, url")
          .eq("owner_id", user.id)
          .order("created_at", { ascending: false }),
        supabase.from("ad_slots").select("id, project_id, status, payout_address, payout_currency"),
        supabase.from("ad_ledger").select("slot_id, amount_cents").eq("kind", "publisher_accrual"),
        supabase
          .from("ad_payouts")
          .select("id, slot_id, amount_cents, currency, status, tx_hash, created_at")
          .order("created_at", { ascending: false }),
        // Lifetime (null window), like the payout figures beside it — but via
        // the RPC rather than the ad_slot_stats view, because the view counts
        // only tier 'paid' and every fill here is free backfill, so every site
        // read 0 impressions while serving six figures of them.
        getSlotTotalsSince(supabase, null),
      ]);
    projects = (p as Project[]) ?? [];
    slots = (s as Slot[]) ?? [];
    statsBySlot = slotStats.data;
    statsFailed = slotStats.failed;
    for (const row of (ledger as { slot_id: string; amount_cents: number }[]) ?? []) {
      if (row.slot_id) earnedBySlot.set(row.slot_id, (earnedBySlot.get(row.slot_id) ?? 0) + (row.amount_cents ?? 0));
    }
    for (const row of (payouts as Payout[]) ?? []) {
      if (!row.slot_id) continue;
      if (row.status !== "failed")
        withdrawnBySlot.set(row.slot_id, (withdrawnBySlot.get(row.slot_id) ?? 0) + (row.amount_cents ?? 0));
      const list = payoutsBySlot.get(row.slot_id) ?? [];
      list.push(row);
      payoutsBySlot.set(row.slot_id, list);
    }
  }

  const tokens = await fetchSupportedTokens().catch(() => []);
  const coins = (tokens.length > 0 ? tokens : FALLBACK_COINS).map((t) => ({
    code: t.code,
    label: `${t.symbol}${t.chain ? ` · ${t.chain}` : ""}`,
  }));

  const slotByProject = new Map(slots.map((s) => [s.project_id, s]));

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/dashboard/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Monetize your site</h1>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/ads/earnings" className="btn whitespace-nowrap">
            Earnings &amp; reports
          </Link>
          {/* Always-visible way to add a site to monetize — a site is a project,
              so this starts the project-creation flow. Previously the only link
              to it was hidden inside the empty state. */}
          <Link href="/dashboard/projects/new?next=/ads/slots" className="btn btn-primary whitespace-nowrap">
            Monetize a new site
          </Link>
        </div>
      </div>
      <p className="mt-2 text-[var(--color-muted)]">
        Each site you monetize is a CrawlProof <strong>project</strong>. Add a site to
        create one, drop one tag on the page, and add a payout wallet — you earn crypto
        for the clicks.
      </p>

      {statsFailed && <StatsUnavailable what="your delivery and earnings figures" />}

      {projects.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-[var(--color-muted)]">
          No sites yet — a site is a CrawlProof project.{" "}
          <Link href="/dashboard/projects/new?next=/ads/slots" className="text-[var(--color-accent)]">
            Add one
          </Link>{" "}
          to enable a slot.
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {projects.map((p) => {
            const slot = slotByProject.get(p.id) ?? null;
            const earned = slot ? earnedBySlot.get(slot.id) ?? 0 : 0;
            const withdrawn = slot ? withdrawnBySlot.get(slot.id) ?? 0 : 0;
            const stat = slot ? statsBySlot.get(slot.id) : undefined;
            return (
              <SlotManager
                key={p.id}
                project={p}
                slot={slot}
                origin={env.siteUrl}
                availableCents={earned - withdrawn}
                coins={coins}
                payouts={slot ? payoutsBySlot.get(slot.id) ?? [] : []}
                stats={
                  stat
                    ? {
                        // Paid inventory plus free backfill: what the site
                        // actually showed, not just what someone paid for.
                        impressions: deliveredImpressions(stat),
                        clicks: deliveredClicks(stat),
                        earnedCents: stat.earnedCents,
                      }
                    : null
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
