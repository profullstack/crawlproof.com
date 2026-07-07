import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { fetchSupportedTokens } from "@/lib/coinpay-tokens";
import { SlotManager } from "@/components/ads/slot-manager";

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

export default async function SlotsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let projects: Project[] = [];
  let slots: Slot[] = [];
  const earnedBySlot = new Map<string, number>();
  const withdrawnBySlot = new Map<string, number>();
  if (user) {
    const [{ data: p }, { data: s }, { data: ledger }, { data: payouts }] = await Promise.all([
      supabase.from("projects").select("id, name, url").order("created_at", { ascending: false }),
      supabase.from("ad_slots").select("id, project_id, status, payout_address, payout_currency"),
      supabase.from("ad_ledger").select("slot_id, amount_cents").eq("kind", "publisher_accrual"),
      supabase.from("ad_payouts").select("slot_id, amount_cents, status"),
    ]);
    projects = (p as Project[]) ?? [];
    slots = (s as Slot[]) ?? [];
    for (const row of (ledger as { slot_id: string; amount_cents: number }[]) ?? []) {
      if (row.slot_id) earnedBySlot.set(row.slot_id, (earnedBySlot.get(row.slot_id) ?? 0) + (row.amount_cents ?? 0));
    }
    for (const row of (payouts as { slot_id: string; amount_cents: number; status: string }[]) ?? []) {
      if (row.slot_id && row.status !== "failed")
        withdrawnBySlot.set(row.slot_id, (withdrawnBySlot.get(row.slot_id) ?? 0) + (row.amount_cents ?? 0));
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
      <Link href="/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>
      <h1 className="mt-4 text-3xl font-bold">Monetize your site</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Show CrawlProof network ads on your site and earn crypto for the clicks. Opt a
        project in, drop one tag on your page, and add a payout wallet.
      </p>

      {projects.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-[var(--color-muted)]">
          You have no projects yet.{" "}
          <Link href="/projects/new" className="text-[var(--color-accent)]">
            Create one
          </Link>{" "}
          to enable a slot.
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {projects.map((p) => {
            const slot = slotByProject.get(p.id) ?? null;
            const earned = slot ? earnedBySlot.get(slot.id) ?? 0 : 0;
            const withdrawn = slot ? withdrawnBySlot.get(slot.id) ?? 0 : 0;
            return (
              <SlotManager
                key={p.id}
                project={p}
                slot={slot}
                origin={env.siteUrl}
                availableCents={earned - withdrawn}
                coins={coins}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
