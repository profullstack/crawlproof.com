import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BuyCreditsButton } from "./buy-credits-button";
import { PurchaseStatusBanner } from "./purchase-status-banner";
import {
  CREDIT_PACKS,
  CREDIT_RACK_CENTS,
  discountPct,
  dollars,
  perScanCents,
} from "@/lib/credits";

export const metadata = { title: "Billing" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits_balance")
    .eq("id", user!.id)
    .maybeSingle();

  const { data: purchases } = await supabase
    .from("credit_purchases")
    .select(
      "id, pack_id, credits_added, amount_cents, status, created_at, completed_at, coinpay_payment_id",
    )
    .eq("owner_id", user!.id)
    .order("created_at", { ascending: false })
    .limit(20);

  // For the success banner, latch onto the most recent purchase from the last
  // hour so we can show the real status (and poll if pending) instead of the
  // optimistic "Payment received" message that Stripe's redirect carried.
  const latest = purchases?.[0];
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent =
    latest && new Date(latest.created_at).getTime() > oneHourAgo
      ? latest
      : null;

  return (
    <div className="space-y-6">
      <Link href="/settings" className="text-sm text-[var(--color-muted)]">
        ← Settings
      </Link>
      <h1 className="text-3xl font-bold">Billing</h1>

      {sp.purchase === "success" && recent && (
        <PurchaseStatusBanner
          initial={{
            id: recent.id,
            coinpay_payment_id: recent.coinpay_payment_id ?? null,
            status: recent.status,
            credits_added: recent.credits_added,
          }}
        />
      )}
      {sp.purchase === "cancel" && (
        <div className="card border-[rgba(251,191,36,0.4)] p-4 text-sm text-[var(--color-warn)]">
          Payment cancelled. No credits were charged.
        </div>
      )}

      <div className="card p-5">
        <div className="text-sm text-[var(--color-muted)]">Scan credits</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-4xl font-extrabold">{profile?.credits_balance ?? 0}</span>
          <span className="text-[var(--color-muted)]">credits</span>
        </div>
        <div className="mt-2 text-xs text-[var(--color-muted)]">
          1 credit = 1 scan. Scheduled re-runs spend 1 credit each.
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Buy more credits</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {CREDIT_PACKS.map((p) => {
            const off = discountPct(p);
            return (
              <div
                key={p.id}
                className={`card p-5 ${p.popular ? "ring-2 ring-[var(--color-accent)]" : ""}`}
              >
                <div className="flex items-baseline justify-between">
                  <div className="font-semibold">{p.label}</div>
                  {p.popular ? (
                    <span className="badge badge-pass">Popular</span>
                  ) : off > 0 ? (
                    <span className="badge badge-warn">{off}% off</span>
                  ) : null}
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-2xl font-extrabold">{dollars(p.amountCents)}</span>
                  {off > 0 && (
                    <span className="text-xs text-[var(--color-muted)] line-through">
                      {dollars(p.credits * CREDIT_RACK_CENTS)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-[var(--color-muted)]">
                  {p.credits} credit{p.credits === 1 ? "" : "s"} ·{" "}
                  <span className="font-mono">{dollars(perScanCents(p))}/scan</span>
                </div>
                <BuyCreditsButton packId={p.id} />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Purchase history</h2>
        {purchases && purchases.length > 0 ? (
          <ul className="space-y-2">
            {purchases.map((p) => (
              <li key={p.id} className="card flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-medium">
                    +{p.credits_added} credits · {dollars(p.amount_cents)}
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {new Date(p.created_at).toLocaleString()}
                  </div>
                </div>
                <span
                  className={`badge ${
                    p.status === "complete"
                      ? "badge-pass"
                      : p.status === "failed"
                        ? "badge-fail"
                        : p.status === "refunded"
                          ? "badge-warn"
                          : "badge-unknown"
                  }`}
                >
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">No purchases yet.</p>
        )}
      </section>
    </div>
  );
}
