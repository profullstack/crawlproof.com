import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BuyCreditsButton } from "./buy-credits-button";
import { CREDIT_PACKS, dollars } from "@/lib/credits";

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
    .select("id, pack_id, credits_added, amount_cents, status, created_at, completed_at")
    .eq("owner_id", user!.id)
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="space-y-6">
      <Link href="/settings" className="text-sm text-[var(--color-muted)]">
        ← Settings
      </Link>
      <h1 className="text-3xl font-bold">Billing</h1>

      {sp.purchase === "success" && (
        <div className="card border-[rgba(52,211,153,0.4)] p-4 text-sm text-[var(--color-pass)]">
          Payment received. Credits will land in your balance as soon as the
          CoinPay webhook confirms (usually a few seconds).
        </div>
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
          {CREDIT_PACKS.map((p) => (
            <div
              key={p.id}
              className={`card p-5 ${p.popular ? "ring-2 ring-[var(--color-accent)]" : ""}`}
            >
              <div className="flex items-baseline justify-between">
                <div className="font-semibold">{p.label}</div>
                {p.popular && <span className="badge badge-pass">Popular</span>}
              </div>
              <div className="mt-2 text-2xl font-extrabold">{dollars(p.amountCents)}</div>
              <div className="text-xs text-[var(--color-muted)]">
                {p.credits} scan{p.credits === 1 ? "" : "s"}
              </div>
              <BuyCreditsButton packId={p.id} />
            </div>
          ))}
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
