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
import { getCategory, type Recency } from "@/lib/alerts/categories";
import { CreateAlert } from "./create-alert";
import { AlertActions } from "./alert-actions";

export const metadata = {
  title: "Free web alerts — CrawlProof Alerts",
  description:
    "Free, near-realtime email alerts for anything Google can see: brand mentions, new backlinks, buying-intent searches, and more. Build one now — sign in to save it.",
};

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
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const RECENCIES = new Set<Recency>(["day", "week", "month", "any"]);

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; term?: string; recency?: string; frequency?: string }>;
}) {
  const { new: newCat, term, recency, frequency } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ---------- Public (not signed in): build the alert, sign in to save ----------
  if (!user) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-14 sm:px-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold sm:text-4xl">Know the moment the web mentions you</h1>
          <p className="mx-auto mt-3 max-w-xl text-[var(--color-muted)]">
            Free email alerts for brand mentions, new backlinks, competitor moves, and buying-intent
            searches — powered by Google, verified by CrawlProof&apos;s crawler. Build one below; sign in
            to save it.
          </p>
        </div>
        <div className="mt-8">
          <CreateAlert authed={false} remainingSlots={MAX_ACTIVE_ALERTS.free} />
        </div>
        <p className="mt-4 text-center text-sm text-[var(--color-muted)]">
          Already have an account?{" "}
          <Link href="/login?redirect=/alerts" className="text-[var(--color-accent)]">
            Log in
          </Link>
          .
        </p>
      </main>
    );
  }

  // Post-signin: create the alert carried through login, then clean the URL.
  if (newCat && getCategory(newCat)) {
    await createAlert({
      category: newCat,
      term: term ?? "",
      customQuery: term ?? "",
      recency: recency && RECENCIES.has(recency as Recency) ? (recency as Recency) : undefined,
      frequency: frequency === "hourly" || frequency === "daily" ? frequency : undefined,
    });
    redirect("/alerts");
  }

  // ---------- Signed in: full management dashboard ----------
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
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
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
        </div>
      </div>

      <CreateAlert authed remainingSlots={remaining} />

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
    </main>
  );
}
