"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BidEvent, BidHistoryDay } from "@/lib/ads/bids";
import { AUTOBID_REASON_LABEL, type AutobidReason } from "@/lib/ads/autobid";
import { CREDIT_CENTS } from "@/lib/ads/pricing";

// Bid against what it bought. One chart, three kinds of line:
//
//   * the bid, in credits, as a step — it only moves when a decision is made;
//   * clicks and tracked visits, the outcomes a bid is supposed to buy;
//   * impressions as faint bars underneath, because a bid that wins more of
//     the lottery shows up there first.
//
// Visits are the visits the tracker attributed to this campaign on the
// owner's own sites (the click URL carries ?ref=, and the tracker buckets it
// as ad:<ref>). They exist only where the destination runs the tracker, so a
// flat visits line beside a live clicks line means "not tracked", not "nobody
// stayed".

const BID_COLOR = "#a78bfa";

function dollars(credits: number | null): string {
  if (credits == null) return "—";
  return `$${((credits * CREDIT_CENTS) / 100).toFixed(2)}`;
}

function reasonLabel(reason: string): string {
  return AUTOBID_REASON_LABEL[reason as AutobidReason] ?? reason;
}

export function BidHistory({
  data,
  events,
  autobid,
  failed = false,
}: {
  data: BidHistoryDay[];
  events: BidEvent[];
  autobid: boolean;
  failed?: boolean;
}) {
  const delivery = data.reduce((sum, p) => sum + p.impressions + p.clicks + p.visits, 0);
  const tracked = data.some((p) => p.visits > 0);

  if (failed) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-sm text-[var(--color-muted)]">
        Couldn&apos;t load the bid history. Try again in a moment.
      </div>
    );
  }
  if (delivery === 0 && events.length === 0) {
    return (
      <div className="card flex h-64 items-center justify-center p-4 text-center text-sm text-[var(--color-muted)]">
        No bids recorded yet. Autobid sets the first one within the hour.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Bid vs. clicks</h2>
        <span className="text-xs text-[var(--color-muted)]">
          Last {data.length} days · {autobid ? "bid set automatically" : "bid set by hand"}
        </span>
      </div>
      <div className="h-64 min-h-64 min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          minHeight={256}
          initialDimension={{ width: 640, height: 256 }}
        >
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
              tickFormatter={(v: string) =>
                new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })
              }
            />
            <YAxis
              yAxisId="counts"
              allowDecimals={false}
              stroke="var(--color-muted)"
              tick={{ fontSize: 11 }}
            />
            <YAxis
              yAxisId="bid"
              orientation="right"
              allowDecimals={false}
              stroke={BID_COLOR}
              tick={{ fontSize: 11 }}
              domain={[0, (max: number) => Math.max(4, Math.ceil(max * 1.2))]}
            />
            <YAxis yAxisId="impressions" hide />
            <Tooltip
              contentStyle={{
                background: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) =>
                typeof v === "string" ? new Date(v).toLocaleDateString() : ""
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={((v: any, name: any) =>
                name === "Bid" ? [`${v} credits (${dollars(Number(v))}/click)`, name] : [v, name]) as any}
            />
            <Bar
              yAxisId="impressions"
              dataKey="impressions"
              name="Impressions"
              fill="var(--color-muted)"
              fillOpacity={0.18}
              isAnimationActive={false}
            />
            <Line
              yAxisId="counts"
              type="monotone"
              dataKey="clicks"
              name="Clicks"
              stroke="var(--color-warn)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
            {tracked && (
              <Line
                yAxisId="counts"
                type="monotone"
                dataKey="visits"
                name="Visits"
                stroke="var(--color-accent)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            )}
            <Line
              yAxisId="bid"
              type="stepAfter"
              dataKey="bidCredits"
              name="Bid"
              stroke={BID_COLOR}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <span>
          <span className="mr-1 inline-block size-2 rounded-full" style={{ background: BID_COLOR }} />
          Bid, credits (right)
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-warn)]" />
          Clicks (left)
        </span>
        {tracked ? (
          <span>
            <span className="mr-1 inline-block size-2 rounded-full bg-[var(--color-accent)]" />
            Visits on your site (left)
          </span>
        ) : (
          <span>Visits appear here once the destination runs the CrawlProof tracker.</span>
        )}
        <span>
          <span className="mr-1 inline-block size-2 rounded-sm bg-[var(--color-muted)] opacity-40" />
          Impressions
        </span>
      </div>

      {events.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-[var(--color-muted)]">
              <tr>
                <th className="py-1 pr-3 font-normal">When</th>
                <th className="py-1 pr-3 font-normal">Bid</th>
                <th className="py-1 pr-3 font-normal">Why</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 8).map((e) => (
                <tr key={`${e.ts}-${e.bidCredits}-${e.source}`} className="border-t border-[var(--color-border)]">
                  <td className="whitespace-nowrap py-1 pr-3 tabular-nums">
                    {new Date(e.ts).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-3 font-mono">
                    {e.prevBidCredits != null && e.prevBidCredits !== e.bidCredits
                      ? `${e.prevBidCredits} → ${e.bidCredits}`
                      : e.bidCredits}
                    <span className="ml-1 text-[var(--color-muted)]">{dollars(e.bidCredits)}</span>
                  </td>
                  <td className="py-1 pr-3">
                    {e.source === "manual" ? "Set by hand" : e.source === "seed" ? "Starting bid" : reasonLabel(e.reason)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
