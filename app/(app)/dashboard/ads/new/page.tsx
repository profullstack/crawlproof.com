import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { NewAdForm } from "./form";

export const metadata = { title: "New ad campaign" };

export default async function NewAdPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let credits = 0;
  let bonus = 0;
  let hasDeposited = false;
  if (user) {
    const [{ data: profile }, { count }] = await Promise.all([
      supabase.from("profiles").select("credits_balance, ad_bonus_credits").eq("id", user.id).maybeSingle(),
      supabase
        .from("credit_purchases")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("status", "complete"),
    ]);
    credits = (profile?.credits_balance as number) ?? 0;
    bonus = (profile?.ad_bonus_credits as number) ?? 0;
    hasDeposited = (count ?? 0) > 0;
  }

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>
      <h1 className="mt-4 text-3xl font-bold">Create an ad</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Drop in a landing-page URL and we auto-design on-brand display ads. Preview,
        tweak the copy and colours, or upload your own logo — then save.
      </p>

      {!hasDeposited ? (
        <div className="mt-4 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-3 text-sm">
          🎁 <strong>Launch offer:</strong> your first deposit is matched 100% in bonus ad
          credits (up to $100 free).{" "}
          <Link href="/dashboard/settings/billing" className="underline">
            Add credits
          </Link>
          .
        </div>
      ) : (
        <div className="mt-4 text-sm text-[var(--color-muted)]">
          Balance: <span className="font-mono text-[var(--color-fg)]">{credits} credits</span>
          {bonus > 0 && (
            <>
              {" "}
              + <span className="font-mono text-[var(--color-accent)]">{bonus} bonus</span> ad
              credits
            </>
          )}
        </div>
      )}

      <NewAdForm />
    </div>
  );
}
