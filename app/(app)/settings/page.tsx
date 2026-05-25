import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./form";
import { listTimezones } from "@/lib/timezones";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "display_name, email, credits_balance, retain_raw_html, perf_report_cadence, timezone",
    )
    .eq("id", user!.id)
    .maybeSingle();
  const { common, all } = listTimezones();

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
      <div className="card p-5">
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Connect external accounts to power automated PRs and other
          deeper workflows.
        </p>
        <ul className="mt-3 divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
          <li className="flex items-center justify-between gap-3 p-3">
            <div>
              <p className="text-sm font-medium">GitHub</p>
              <p className="text-xs text-[var(--color-muted)]">
                Install our GitHub App to let CrawlProof open PRs that
                install the stats tracker or apply audit fixes.
              </p>
            </div>
            <Link
              href="/settings/integrations/github"
              className="btn btn-secondary text-sm"
            >
              Manage →
            </Link>
          </li>
        </ul>
      </div>
      <SettingsForm
        displayName={profile?.display_name ?? ""}
        retainRawHtml={!!profile?.retain_raw_html}
        perfReportCadence={
          (profile?.perf_report_cadence ?? "weekly") as
            | "off"
            | "weekly"
            | "monthly"
        }
        timezone={profile?.timezone ?? "UTC"}
        commonTimezones={common}
        allTimezones={all}
      />
    </div>
  );
}
