import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { MonitorPlans, MONITOR_PAYMENT_NOTE } from "@/components/monitor-plans";
import { MonitorSubscribeButton } from "@/components/monitor-subscribe-button";
import {
  MONITOR_PLANS,
  RENEWAL_NOTICE_DAYS,
  priceLabel,
  reconcilePendingMonitorPayments,
  type MonitorSubscription,
} from "@/lib/monitoring";
import { addSiteAction, removeSiteAction, setCancelAction, startTrialAction } from "@/app/actions/monitoring";
import { trialStatus } from "@/lib/trial";

export const metadata = { title: "Weekly monitoring" };
export const dynamic = "force-dynamic";

type Watch = {
  id: string;
  subscription_id: string;
  target_url: string;
  last_score: number | null;
  last_scanned_at: string | null;
  next_run_at: string;
};

function day(iso: string | null): string {
  return iso ? new Date(iso).toUTCString().slice(5, 16) : "not yet";
}

export default async function MonitoringPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string; canceled?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const svc = serviceClient();

  // Back from CoinPay before the webhook landed: ask CoinPay directly.
  if (sp.paid) await reconcilePendingMonitorPayments(svc, user!.id);

  const { data: subRows } = await svc
    .from("monitor_subscriptions")
    .select("*")
    .eq("owner_id", user!.id)
    .neq("status", "pending")
    .order("created_at", { ascending: false });
  const subs = (subRows ?? []) as MonitorSubscription[];

  const { data: watchRows } = subs.length
    ? await svc
        .from("scan_watches")
        .select("id, subscription_id, target_url, last_score, last_scanned_at, next_run_at")
        .in("subscription_id", subs.map((s) => s.id))
        .is("unsubscribed_at", null)
        .order("created_at", { ascending: true })
    : { data: [] };
  const watches = (watchRows ?? []) as Watch[];
  const { data: prof } = await svc.from("profiles").select("trial_ends_at, trial_credits").eq("id", user!.id).maybeSingle();
  const trial = trialStatus(prof);
  const { count: trialRows } = await svc
    .from("monitor_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", user!.id)
    .eq("is_trial", true);
  const canTrial = trial.active && !trialRows && !subs.some((s) => s.status === "active");

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold">Weekly monitoring</h1>
        <p className="mt-1 text-[var(--color-muted)]">
          Each site is re-audited every week; you get an email when its score moves.
        </p>
      </div>

      {sp.paid && subs.every((s) => s.status !== "active") && (
        <div className="card p-4 text-sm">
          Payment received by CoinPay. Crypto payments can take a few minutes to confirm; this page
          updates once they do.
        </div>
      )}
      {sp.canceled && <div className="card p-4 text-sm">Checkout was cancelled. Nothing was charged.</div>}

      {canTrial && (
        <form action={startTrialAction} className="card space-y-3 border-[var(--color-accent)] p-6">
          <h2 className="text-xl font-bold">Try Solo monitoring free for {trial.daysLeft} days</h2>
          <p className="text-sm text-[var(--color-muted)]">
            Part of your free trial. No card, nothing renews: one site re-audited every week until your trial ends,
            then pay for a month only if you want to keep it.
          </p>
          <div className="flex flex-wrap gap-2">
            <input name="url" className="input flex-1" placeholder="https://yoursite.com" />
            <button className="btn btn-primary">Start free trial</button>
          </div>
        </form>
      )}

      {subs.length === 0 && (
        <>
          <MonitorPlans />
          <p className="text-sm text-[var(--color-muted)]">{MONITOR_PAYMENT_NOTE}</p>
        </>
      )}

      {subs.map((sub) => {
        const plan = MONITOR_PLANS[sub.plan];
        const sites = watches.filter((w) => w.subscription_id === sub.id);
        const active = sub.status === "active";
        const end = sub.current_period_end ? Date.parse(sub.current_period_end) : 0;
        const renewOpen = !active || end - Date.now() < RENEWAL_NOTICE_DAYS * 24 * 60 * 60 * 1000;
        return (
          <section key={sub.id} className="card space-y-5 p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-xl font-bold">
                {plan.label} · {sub.is_trial ? "free trial" : `${priceLabel(plan.amountCents)}/month`}
              </h2>
              <span className="text-sm text-[var(--color-muted)]">
                {active
                  ? sub.cancel_at_period_end
                    ? `Cancelled: runs until ${day(sub.current_period_end)}`
                    : sub.is_trial
                      ? `Free until ${day(sub.current_period_end)}`
                      : `Paid through ${day(sub.current_period_end)}`
                  : sub.status === "canceled"
                    ? "Cancelled"
                    : "Expired"}
              </span>
            </div>

            {active && (
              <div>
                <h3 className="font-semibold">
                  Sites ({sites.length}/{sub.site_limit})
                </h3>
                <ul className="mt-3 divide-y divide-[var(--color-border)]">
                  {sites.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                      <span className="font-mono break-all">{w.target_url}</span>
                      <span className="text-[var(--color-muted)]">
                        {w.last_score !== null ? `${w.last_score}/100` : "first scan pending"} · last run{" "}
                        {day(w.last_scanned_at)}
                      </span>
                      <form action={removeSiteAction}>
                        <input type="hidden" name="subscriptionId" value={sub.id} />
                        <input type="hidden" name="watchId" value={w.id} />
                        <button type="submit" className="text-xs text-[var(--color-muted)] hover:underline">
                          Remove
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
                {sites.length < sub.site_limit && (
                  <form action={addSiteAction} className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input type="hidden" name="subscriptionId" value={sub.id} />
                    <input
                      name="url"
                      required
                      placeholder="https://client-site.com"
                      className="input flex-1"
                      aria-label="Site URL"
                    />
                    <button type="submit" className="btn">
                      Add site
                    </button>
                  </form>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-4">
              {renewOpen && !sub.cancel_at_period_end && (
                <div className="w-full sm:w-auto">
                  <MonitorSubscribeButton
                    plan={sub.plan}
                    subscriptionId={sub.id}
                    label={active ? `Pay next month (${priceLabel(plan.amountCents)})` : `Restart (${priceLabel(plan.amountCents)})`}
                  />
                </div>
              )}
              {active && (
                <form action={setCancelAction}>
                  <input type="hidden" name="subscriptionId" value={sub.id} />
                  <input type="hidden" name="cancel" value={sub.cancel_at_period_end ? "0" : "1"} />
                  <button type="submit" className="btn">
                    {sub.cancel_at_period_end ? "Keep monitoring" : "Cancel"}
                  </button>
                </form>
              )}
            </div>
          </section>
        );
      })}

      <p className="text-sm text-[var(--color-muted)]">
        Reports from each run are linked in the change emails.{" "}
        <Link href="/monitor" className="hover:underline">
          Plan details
        </Link>
      </p>
    </div>
  );
}
