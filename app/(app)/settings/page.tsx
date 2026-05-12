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
    .select("display_name, email, plan, retain_raw_html, monthly_audit_count")
    .eq("id", user!.id)
    .maybeSingle();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>
      <div className="card p-5">
        <div className="text-sm text-[var(--color-muted)]">Plan</div>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-xl font-bold capitalize">{profile?.plan}</span>
          <Link href="/settings/billing" className="btn">
            Manage billing
          </Link>
        </div>
        <div className="mt-3 text-sm text-[var(--color-muted)]">
          {profile?.monthly_audit_count ?? 0} audits this month
        </div>
      </div>
      <SettingsForm
        displayName={profile?.display_name ?? ""}
        retainRawHtml={!!profile?.retain_raw_html}
      />
    </div>
  );
}
