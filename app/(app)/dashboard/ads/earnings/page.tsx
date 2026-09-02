import Link from "next/link";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/server";
import { loadEarnings, dollars, type EarningsModel } from "@/lib/ads/earnings-data";
import { EarningsPdfButton } from "@/components/ads/earnings-pdf-button";
import { StatsUnavailable } from "@/components/stats-unavailable";

// recharts is client-only; keep it out of the server bundle.
const MoneyTrend = dynamic(() => import("@/components/ads/money-trend").then((m) => m.MoneyTrend));

export const metadata = { title: "Earnings & spend" };

const RANGE = 30;

function ctr(clicks: number, impressions: number): string {
  return impressions ? `${((clicks / impressions) * 100).toFixed(1)}%` : "—";
}

const EMPTY: EarningsModel = {
  rangeDays: RANGE,
  // Signed out: nothing was attempted, so nothing failed.
  statsUnavailable: false,
  totals: {
    spentCents: 0,
    earnedCents: 0,
    netCents: 0,
    availableCents: 0,
    withdrawnCents: 0,
    spendTodayCents: 0,
    earnedTodayCents: 0,
    advImpressions: 0,
    advClicks: 0,
    pubImpressions: 0,
    pubClicks: 0,
    invalidClicks: 0,
  },
  campaigns: [],
  slots: [],
  payouts: [],
  daily: [],
};

export default async function EarningsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const model = user ? await loadEarnings(supabase, user.id, RANGE) : EMPTY;
  const t = model.totals;

  // Money that moved *in the window*, which the balance tiles cannot answer —
  // they are lifetime. Delivery with no money behind it in the same window is
  // what the free-tier note explains, and this is the only figure that tells
  // the two apart.
  const rangeEarnedCents = model.slots.reduce((a, s) => a + s.earnedCents, 0);
  const rangeSpentCents = model.campaigns.reduce((a, c) => a + c.spentCents, 0);
  const deliveredInRange = t.pubImpressions > 0 || t.advImpressions > 0;
  const invalidNote =
    t.invalidClicks === 1
      ? "1 further click was filtered as invalid"
      : `${t.invalidClicks.toLocaleString()} further clicks were filtered as invalid`;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/dashboard/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Earnings &amp; spend</h1>
        <EarningsPdfButton days={RANGE} />
      </div>
      <p className="mt-2 text-[var(--color-muted)]">
        Your CrawlProof ad money across both sides — what you earn as a publisher and what
        you spend as an advertiser. Download a PDF report for your accountant or team.
      </p>

      {model.statsUnavailable && (
        <StatsUnavailable what="delivery figures for this period" />
      )}

      {/* Balances, not a period. "Available to withdraw" is lifetime earnings
          minus lifetime payouts; clipping it to the last {RANGE} days would
          under-report money the account is owed. The tables below are the ones
          that cover a window, and they say so. */}
      <h2 className="mt-6 text-sm font-medium uppercase tracking-wider text-[var(--color-muted)]">
        Balance · all time
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total earned" value={dollars(t.earnedCents)} accent />
        <Stat label="Total spend" value={dollars(t.spentCents)} />
        <Stat label="Net" value={dollars(t.netCents)} accent={t.netCents >= 0} danger={t.netCents < 0} />
        <Stat label="Available to withdraw" value={dollars(t.availableCents)} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Earned today" value={dollars(t.earnedTodayCents)} />
        <MiniStat label="Spent today" value={dollars(t.spendTodayCents)} />
        <MiniStat label="Withdrawn" value={dollars(t.withdrawnCents)} />
        <MiniStat label="Net" value={dollars(t.netCents)} />
      </div>

      {/* Everything below covers the window, and the heading is the only place
          that has to say so. */}
      <h2 className="mt-8 text-sm font-medium uppercase tracking-wider text-[var(--color-muted)]">
        Delivery · last {RANGE} days
      </h2>

      <div className="mt-3">
        <MoneyTrend data={model.daily} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat
          label="Publisher impr."
          value={t.pubImpressions.toLocaleString()}
        />
        <MiniStat label="Publisher clicks" value={t.pubClicks.toLocaleString()} />
        <MiniStat
          label="Advertiser impr."
          value={t.advImpressions.toLocaleString()}
        />
        <MiniStat label="Advertiser clicks" value={t.advClicks.toLocaleString()} />
      </div>

      {/* Delivery counts free backfill, so a range that earned nothing still
          reports the traffic it carried. Without this line the tables read as a
          billing fault rather than as the free tier working. */}
      {deliveredInRange && rangeEarnedCents === 0 && rangeSpentCents === 0 && (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Impressions and clicks count free-tier backfill as well as paid inventory — a
          campaign out of credits or daily budget, or one running on a slot its own
          account owns. It bills nobody and earns nobody, which is why delivery can be
          busy while the money is flat.
        </p>
      )}

      {/* Otherwise these are recorded and shown nowhere, and on a site under a
          bot run they are most of the click volume. */}
      {t.invalidClicks > 0 && (
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {invalidNote} — bot, duplicate, forged, or against a campaign that was not
          servable — and left out of the figures above.
        </p>
      )}

      {/* Publisher earnings */}
      <h2 className="mt-8 text-xl font-semibold">Earnings by site</h2>
      {model.slots.length === 0 ? (
        <div className="card mt-3 p-6 text-center text-sm text-[var(--color-muted)]">
          No monetized sites yet.{" "}
          <Link href="/dashboard/ads/slots" className="text-[var(--color-accent)]">
            Monetize a site
          </Link>
          .
        </div>
      ) : (
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <Th>Site</Th>
                <Th>Status</Th>
                <Th right>Impr.</Th>
                <Th right>Clicks</Th>
                <Th right>CTR</Th>
                <Th right>Earned</Th>
              </tr>
            </thead>
            <tbody>
              {model.slots.map((s) => (
                <tr key={s.id} className="border-t border-[var(--color-border)]">
                  <Td>{s.name}</Td>
                  <Td>
                    <span className="badge whitespace-nowrap">{s.status}</span>
                  </Td>
                  <Td right>{s.impressions.toLocaleString()}</Td>
                  <Td right>{s.clicks.toLocaleString()}</Td>
                  <Td right>{ctr(s.clicks, s.impressions)}</Td>
                  <Td right mono>
                    {dollars(s.earnedCents)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Advertiser spend */}
      <h2 className="mt-8 text-xl font-semibold">Spend by campaign</h2>
      {model.campaigns.length === 0 ? (
        <div className="card mt-3 p-6 text-center text-sm text-[var(--color-muted)]">
          No ad campaigns yet.{" "}
          <Link href="/dashboard/ads/new" className="text-[var(--color-accent)]">
            Create an ad
          </Link>
          .
        </div>
      ) : (
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <Th>Campaign</Th>
                <Th>Status</Th>
                <Th right>Impr.</Th>
                <Th right>Clicks</Th>
                <Th right>CTR</Th>
                <Th right>Spent</Th>
              </tr>
            </thead>
            <tbody>
              {model.campaigns.map((c) => (
                <tr key={c.id} className="border-t border-[var(--color-border)]">
                  <Td>{c.name}</Td>
                  <Td>
                    <span className="badge whitespace-nowrap">{c.status}</span>
                  </Td>
                  <Td right>{c.impressions.toLocaleString()}</Td>
                  <Td right>{c.clicks.toLocaleString()}</Td>
                  <Td right>{ctr(c.clicks, c.impressions)}</Td>
                  <Td right mono>
                    {dollars(c.spentCents)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {model.payouts.length > 0 && (
        <>
          <h2 className="mt-8 text-xl font-semibold">Payout history</h2>
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  <Th>Date</Th>
                  <Th right>Amount</Th>
                  <Th>Currency</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {model.payouts.map((p, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)]">
                    <Td>{new Date(p.createdAt).toLocaleDateString()}</Td>
                    <Td right mono>
                      {dollars(p.amountCents)}
                    </Td>
                    <Td>{p.currency.toUpperCase()}</Td>
                    <Td>{p.status}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent = false,
  danger = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div
        className={`mt-1 text-2xl font-bold ${
          danger ? "text-red-400" : accent ? "text-[var(--color-accent)]" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 font-mono font-semibold">{value}</div>
    </div>
  );
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

function Td({
  children,
  right = false,
  mono = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
}) {
  return (
    <td className={`px-4 py-2 ${right ? "text-right" : ""} ${mono ? "font-mono font-semibold" : ""}`}>
      {children}
    </td>
  );
}
