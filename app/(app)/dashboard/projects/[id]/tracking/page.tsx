import { notFound } from "next/navigation";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { getOrCreateForProject } from "@/lib/emailTracking/store";
import { exampleUrls } from "@/lib/emailTracking/core";
import { env } from "@/lib/env";
import { TrackingControls } from "./tracking-controls";

export const metadata = {
  title: "Email tracking",
  description: "Open, click and unsubscribe tracking for email sent from any tool.",
};
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

type StatRow = {
  campaign: string;
  variant: string;
  opens: number;
  unique_opens: number;
  machine_opens: number;
  clicks: number;
  unique_clicks: number;
  unsubscribes: number;
};

type UrlRow = {
  campaign: string;
  variant: string;
  url: string;
  clicks: number;
  unique_clicks: number;
};

const fmt = (n: number | string) => Number(n).toLocaleString("en-US");

export default async function TrackingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireProjectAccess(id, { allowViewer: true });
  if (!access.ok) notFound();

  const tracking = await getOrCreateForProject(id);
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  // Security invoker RPCs: RLS on email_tracking_events decides what this
  // session may read, the same as the tracker panels.
  const [statsRes, urlsRes] = await Promise.all([
    access.supabase.rpc("email_tracking_stats", { p_project: id, p_since: since }),
    access.supabase.rpc("email_tracking_top_urls", { p_project: id, p_since: since, p_limit: 20 }),
  ]);
  const stats = (statsRes.data ?? []) as StatRow[];
  const urls = (urlsRes.data ?? []) as UrlRow[];
  const statsError = statsRes.error || urlsRes.error;

  const examples = exampleUrls(env.siteUrl, tracking.tracking_id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Email tracking</h2>
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          One tracking URL for this project. Put the open pixel, wrapped links and
          an unsubscribe link in email you send from any tool, and the results show
          up here. Nothing is recorded until you turn it on.
        </p>
      </div>

      <TrackingControls
        projectId={id}
        initialEnabled={tracking.enabled}
        canEdit={!access.isViewer}
        secret={access.isViewer ? null : tracking.secret}
        rotatedAt={tracking.secret_rotated_at}
        examples={examples}
      />

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 text-sm">
        <h3 className="font-semibold">What this can and cannot see</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--color-muted)]">
          <li>
            Opens are approximate. Many mail apps block images, so some real opens are
            never counted. Apple Mail Privacy Protection and Gmail&apos;s image proxy load
            the pixel on their own, so those loads are marked as machine opens and kept
            out of the Opens column.
          </li>
          <li>Clicks are counted when someone follows a signed link. Link scanners are marked as machine clicks.</li>
          <li>Deletes are invisible. No email tracking can see a message being deleted or closed.</li>
          <li>Replies land in the sender&apos;s inbox, not here. A pixel cannot see a reply.</li>
          <li>
            IP addresses are never stored. Email addresses are stored only when someone
            unsubscribes, because the sender has to honour it.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="font-semibold">Results, last {WINDOW_DAYS} days</h3>
          <p className="text-sm text-[var(--color-muted)]">
            Per campaign (<code>c</code>) and variant (<code>v</code>). Sends are not known
            to CrawlProof, so there are no rates here: divide by your own send counts.
            Unique counts are distinct message ids (<code>m</code>).
          </p>
        </div>
        {statsError ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
            Stats are unavailable right now. Try again in a minute.
          </div>
        ) : stats.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-6 text-sm text-[var(--color-muted)]">
            {tracking.enabled
              ? "No opens, clicks or unsubscribes yet."
              : "Tracking is off. Turn it on above, then send an email with the pixel in it."}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-card)] text-left text-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 font-medium">Variant</th>
                  <th className="px-4 py-2 text-right font-medium">Opens</th>
                  <th className="px-4 py-2 text-right font-medium">Unique opens</th>
                  <th className="px-4 py-2 text-right font-medium">Machine opens</th>
                  <th className="px-4 py-2 text-right font-medium">Clicks</th>
                  <th className="px-4 py-2 text-right font-medium">Unique clicks</th>
                  <th className="px-4 py-2 text-right font-medium">Unsubscribes</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((r) => (
                  <tr key={`${r.campaign}\u0000${r.variant}`} className="border-t border-[var(--color-border)]">
                    <td className="px-4 py-2 break-all">{r.campaign || <span className="text-[var(--color-muted)]">(none)</span>}</td>
                    <td className="px-4 py-2 break-all">{r.variant || <span className="text-[var(--color-muted)]">(none)</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.opens)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.unique_opens)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-[var(--color-muted)]">{fmt(r.machine_opens)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.clicks)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.unique_clicks)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.unsubscribes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!statsError && urls.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="font-semibold">Top clicked links</h3>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-card)] text-left text-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 font-medium">URL</th>
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 font-medium">Variant</th>
                  <th className="px-4 py-2 text-right font-medium">Clicks</th>
                  <th className="px-4 py-2 text-right font-medium">Unique clicks</th>
                </tr>
              </thead>
              <tbody>
                {urls.map((r) => (
                  <tr key={`${r.campaign}\u0000${r.variant}\u0000${r.url}`} className="border-t border-[var(--color-border)]">
                    <td className="max-w-md px-4 py-2 break-all">{r.url}</td>
                    <td className="px-4 py-2 break-all">{r.campaign || <span className="text-[var(--color-muted)]">(none)</span>}</td>
                    <td className="px-4 py-2 break-all">{r.variant || <span className="text-[var(--color-muted)]">(none)</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.clicks)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt(r.unique_clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
