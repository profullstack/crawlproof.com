import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CampaignActions } from "@/components/ads/campaign-actions";
import { MiniTrend } from "@/components/ads/mini-trend";
import { getCampaignDailySeries, type CampaignDailyPoint } from "@/lib/ads/series";
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

type StatRow = {
  campaign_id: string;
  impressions: number;
  clicks: number;
  spent_cents: number;
  total_spent_cents: number;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ctr(clicks: number, impressions: number): string {
  if (!impressions) return "—";
  return `${((clicks / impressions) * 100).toFixed(1)}%`;
}

export default async function AdsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let campaigns: CampaignRow[] = [];
  const statsById = new Map<string, StatRow>();
  let seriesById = new Map<string, CampaignDailyPoint[]>();
  if (user) {
    const [{ data }, { data: stats }] = await Promise.all([
      supabase
        .from("ad_campaigns")
        .select(
          "id, ref_slug, name, destination_domain, daily_budget_cents, bid_credits, spend_today_cents, spend_date, status, created_at",
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("ad_campaign_stats")
        .select("campaign_id, impressions, clicks, spent_cents, total_spent_cents"),
    ]);
    campaigns = (data as CampaignRow[]) ?? [];
    for (const s of (stats as StatRow[]) ?? []) statsById.set(s.campaign_id, s);
    seriesById = await getCampaignDailySeries(
      supabase,
      campaigns.map((c) => c.id),
      30,
    );
  }

  const today = utcToday();

  const totals = [...statsById.values()].reduce(
    (a, s) => ({
      impressions: a.impressions + (s.impressions ?? 0),
      clicks: a.clicks + (s.clicks ?? 0),
      spent: a.spent + (s.total_spent_cents ?? 0),
    }),
    { impressions: 0, clicks: 0, spent: 0 },
  );

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
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Impressions" value={totals.impressions.toLocaleString()} />
          <Stat label="Clicks" value={totals.clicks.toLocaleString()} />
          <Stat label="CTR" value={ctr(totals.clicks, totals.impressions)} />
          <Stat label="Total spend" value={dollars(totals.spent)} />
        </div>
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
            const s = statsById.get(c.id);
            const impr = s?.impressions ?? 0;
            const clk = s?.clicks ?? 0;
            const display = campaignDisplayStatus(c, today);
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
                  <MiniStat label="Spent" value={dollars(s?.total_spent_cents ?? 0)} />
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
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
