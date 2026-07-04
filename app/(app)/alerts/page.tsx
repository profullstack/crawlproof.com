import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { createAlert } from "@/app/actions/alerts";
import {
  MAX_ACTIVE_ALERTS,
  SERP_CALLS_PER_MONTH,
  planFromProfile,
} from "@/lib/alerts/limits";
import { getCategory } from "@/lib/alerts/categories";
import { CreateAlert } from "./create-alert";
import { AlertActions } from "./alert-actions";

export const metadata = { title: "Alerts" };

type AlertRow = {
  id: string;
  label: string;
  category: string;
  status: string;
  recency: string;
  frequency: string;
  last_checked_at: string | null;
  confirm_backlink: boolean;
};

function fmt(ts: string | null): string {
  if (!ts) return "not yet";
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; term?: string }>;
}) {
  const { new: newCat, term } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Post-signup: create the alert carried in the magic-link redirect, then
  // strip the params so a refresh can't double-create.
  if (newCat && getCategory(newCat)) {
    await createAlert({ category: newCat, term: term ?? "", customQuery: term ?? "" });
    redirect("/alerts");
  }

  const svc = serviceClient();
  const { data: profile } = await svc
    .from("profiles")
    .select("plan, alert_serp_calls_used")
    .eq("id", user.id)
    .maybeSingle();
  const plan = planFromProfile(profile?.plan as string | undefined);

  const { data: alertRows } = await svc
    .from("alerts")
    .select("id, label, category, status, recency, frequency, last_checked_at, confirm_backlink")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  const alerts = (alertRows ?? []) as AlertRow[];

  const activeCount = alerts.filter((a) => a.status === "active").length;
  const cap = MAX_ACTIVE_ALERTS[plan];
  const remaining = Math.max(0, cap - activeCount);
  const budget = SERP_CALLS_PER_MONTH[plan];
  const used = (profile?.alert_serp_calls_used as number) ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Alerts</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Free email alerts for anything Google can see — brand mentions, backlinks, buying intent, and more.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="badge">{activeCount}/{cap} active</span>
          <span className="badge">{Math.max(0, budget - used)} checks left this month</span>
          {plan === "free" && (
            <Link href="/settings/billing" className="badge badge-pass">
              Upgrade
            </Link>
          )}
        </div>
      </div>

      <CreateAlert remainingSlots={remaining} allowHourly={plan !== "free"} />

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          Your alerts
        </h2>
        {alerts.length === 0 && (
          <div className="card text-sm text-[var(--color-muted)]">
            No alerts yet. Create your first one above — try your brand name or your domain.
          </div>
        )}
        {alerts.map((a) => (
          <div key={a.id} className="card flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{a.label}</span>
                {a.status === "paused" && <span className="badge badge-warn">paused</span>}
                {a.confirm_backlink && <span className="badge badge-pass">backlink-verified</span>}
              </div>
              <div className="mt-1 text-xs text-[var(--color-muted)]">
                {getCategory(a.category)?.title ?? a.category} · {a.frequency} · last checked {fmt(a.last_checked_at)}
              </div>
            </div>
            <AlertActions alertId={a.id} status={a.status} />
          </div>
        ))}
      </div>
    </div>
  );
}
