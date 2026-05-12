import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./form";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, email, credits_balance, retain_raw_html")
    .eq("id", user!.id)
    .maybeSingle();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>
      <div className="card p-5">
        <div className="text-sm text-[var(--color-muted)]">Scan credits</div>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-2xl font-extrabold">
            {profile?.credits_balance ?? 0}
          </span>
          <Link href="/settings/billing" className="btn">
            Buy credits
          </Link>
        </div>
      </div>
      <SettingsForm
        displayName={profile?.display_name ?? ""}
        retainRawHtml={!!profile?.retain_raw_html}
      />
    </div>
  );
}
