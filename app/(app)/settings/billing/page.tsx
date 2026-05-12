import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { UpgradeButton } from "./upgrade-button";
import { PortalButton } from "./portal-button";

export const metadata = { title: "Billing" };

export default async function BillingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, stripe_customer_id")
    .eq("id", user!.id)
    .maybeSingle();

  return (
    <div className="space-y-6">
      <Link href="/settings" className="text-sm text-[var(--color-muted)]">
        ← Settings
      </Link>
      <h1 className="text-3xl font-bold">Billing</h1>

      <div className="card p-5">
        <div className="text-sm text-[var(--color-muted)]">Current plan</div>
        <div className="text-2xl font-bold capitalize">{profile?.plan}</div>
        <div className="mt-4 flex gap-2">
          {profile?.plan === "pro" ? (
            <PortalButton />
          ) : (
            <UpgradeButton />
          )}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="font-semibold">Pro — $29/month</h2>
        <ul className="mt-2 list-disc pl-5 text-sm text-[var(--color-muted)]">
          <li>Unlimited audits</li>
          <li>Scheduled weekly re-runs</li>
          <li>Diff view</li>
          <li>PDF export</li>
          <li>Private reports</li>
        </ul>
      </div>
    </div>
  );
}
