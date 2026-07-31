import Link from "next/link";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { CampaignActions } from "@/components/ads/campaign-actions";
import { MiniTrend } from "@/components/ads/mini-trend";
import { AccountTrend } from "@/components/ads/account-trend";
import { RangeTabs } from "@/components/ads/range-tabs";
import { StatSpark } from "@/components/ads/stat-spark";
import {
  getAccountSeries,
  getCampaignDailySeries,
  getCampaignRangeTotals,
  sumSeries,
  EMPTY_TOTALS,
  type AccountPoint,
  type CampaignDailyPoint,
  type RangeTotals,
} from "@/lib/ads/series";
import { resolveRange } from "@/lib/ads/ranges";
import { campaignDisplayStatus, spendTodayCents, utcToday } from "@/lib/ads/status";

export const metadata = { title: "Ad campaigns" };

type CampaignRow = {
  id: string;
  ref_slug: string;
  name: string;
  destination_domain: string | null;
  daily_budget_cents: number;
  bid_credits: number | null;
  spend_today_cents: number | null;
  spend_date: string | null;
  status: string;
  created_at: string;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ctr(clicks: number, impressions: number): string {
  if (!impressions) return "—";
  return `${((clicks / impressions) * 100).toFixed(1)}%`;
}

export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = resolveRange((await searchParams).range);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let campaigns: CampaignRow[] = [];
  let seriesById = new Map<string, CampaignDailyPoint[]>();
  let series: AccountPoint[] = [];
  let rangeById = new Map<string, RangeTotals>();
  // Spendable credits decide whether a campaign is on the paid tier or running
  // as free backfill, so the badge can't be derived from the campaign row alone.
  let creditsAvailable: number | null = null;
  if (user) {
    const [{ data }, { data: profile }, accountSeries, campaignTotals] = await Promise.all([
      supabase
        .from("ad_campaigns")
        .select(
          "id, ref_slug, name, destination_domain, daily_budget_cents, bid_credits, spend_today_cents, spend_date, status, created_at",
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("credits_balance, ad_bonus_credits")
        .eq("id", user.id)
        .maybeSingle(),
      getAccountSeries(supabase, range),
      getCampaignRangeTotals(supabase, range),
    ]);
    creditsAvailable = (profile?.credits_balance ?? 0) + (profile?.ad_bonus_credits ?? 0);
    campaigns = (data as CampaignRow[]) ?? [];
    series = accountSeries;
    rangeById = campaignTotals;
    seriesById = await getCampaignDailySeries(
      supabase,
      campaigns.map((c) => c.id),
      30,
    );
  }

  const today = utcToday();
  const totals = sumSeries(series);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Ad campaigns</h1>
        <div className="flex items-center gap-2">
          <Link href="/ads/earnings" className="btn">
            Earnings &amp; reports
          </Link>
          <Link href="/ads/slots" className="btn">
            Monetize a site
          </Link>
          <Link href="/ads/new" className="btn btn-primary">
            Create an ad
          </Link>
        </div>
      </div>
      <p className="mt-2 text-[var(--color-muted)]">
        Promote your site across the CrawlProof network. Give a URL, we design the ads,
        you fund a daily budget — publishers earn crypto for the clicks.
      </p>

      {campaigns.length > 0 && (
        <>
          {/* One filter row, above everything it scopes: the stats, the chart
              and the per-campaign figures all read the same slice. */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Suspense fallback={null}>
              <RangeTabs value={range.id} />
            </Suspense>
            <span className="text-sm text-[var(--color-muted)]">{range.hint}</span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Impressions"
              value={totals.impressions.toLocaleString()}
              spark={<StatSpark data={series} pick={(p) => p.impressions} />}
            />
            <Stat
              label="Clicks"
              value={totals.clicks.toLocaleString()}
              spark={<StatSpark data={series} pick={(p) => p.clicks} />}
            />
            <Stat label="CTR" value={ctr(totals.clicks, totals.impressions)} />
            <Stat
              label="Spend"
              value={dollars(totals.spentCents)}
              spark={<StatSpark data={series} pick={(p) => p.spentCents} />}
            />
          </div>

          {/* Free backfill is delivery that costs and earns nothing, so it never
              belongs in the paid figures above — but hiding it entirely would
              make impressions look like they collapsed when a campaign runs dry. */}
          {(totals.freeImpressions > 0 || totals.freeClicks > 0) && (
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Plus{" "}
              <span className="font-mono font-semibold text-[var(--color-fg)]">
                {totals.freeImpressions.toLocaleString()}
              </span>{" "}
              free-tier impressions and{" "}
              <span className="font-mono font-semibold text-[var(--color-fg)]">
                {totals.freeClicks.toLocaleString()}
              </span>{" "}
              free clicks in this range, at no cost.
            </p>
          )}

          <div className="mt-4">
            <AccountTrend data={series} range={range} />
          </div>
        </>
      )}

      {campaigns.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-[var(--color-muted)]">
          No campaigns yet.{" "}
          <Link href="/ads/new" className="text-[var(--color-accent)]">
            Create your first ad
          </Link>
          .
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {campaigns.map((c) => {
            // Range-scoped, so a row never contradicts the header above it.
            const s = rangeById.get(c.id) ?? EMPTY_TOTALS;
            const impr = s.impressions;
            const clk = s.clicks;
            const display = campaignDisplayStatus(c, today, creditsAvailable);
            return (
              <li key={c.id} className="card p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Link href={`/ads/${c.id}`} className="block truncate font-semibold hover:text-[var(--color-accent)]">
                      {c.name}
                    </Link>
                    <div className="truncate text-sm text-[var(--color-muted)]">
                      {c.destination_domain} · {dollars(c.daily_budget_cents)}/day ·{" "}
                      <span className="font-mono">{c.ref_slug}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link href={`/ads/${c.id}`} className="hidden sm:block" aria-label="View campaign">
                      <MiniTrend data={seriesById.get(c.id) ?? []} />
                    </Link>
                    <span className="badge whitespace-nowrap" title={display.hint}>
                      {display.label}
                    </span>
                    <Link href={`/ads/${c.id}/edit`} className="btn text-sm">
                      Edit
                    </Link>
                    <CampaignActions id={c.id} status={c.status} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--color-border)] pt-3 text-sm">
                  <MiniStat label="Impressions" value={impr.toLocaleString()} />
                  <MiniStat label="Clicks" value={clk.toLocaleString()} />
                  <MiniStat label="CTR" value={ctr(clk, impr)} />
                  <MiniStat label="Spent" value={dollars(s.spentCents)} />
                  {s.freeImpressions > 0 && (
                    <MiniStat label="Free" value={s.freeImpressions.toLocaleString()} />
                  )}
                  <MiniStat
                    label="Today"
                    value={`${dollars(spendTodayCents(c, today))} / ${dollars(c.daily_budget_cents)}`}
                  />
                </div>
                {!display.serving && (
                  <p className="mt-2 text-sm text-[var(--color-muted)]">{display.hint}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  spark,
}: {
  label: string;
  value: string;
  spark?: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {spark && <div className="mt-2">{spark}</div>}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span className="font-mono font-semibold">{value}</span>
    </span>
  );
}
