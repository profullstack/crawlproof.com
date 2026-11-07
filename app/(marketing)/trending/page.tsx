import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { currentTrends } from "@/lib/ads/trends";
import { TREND_WINDOW_DAYS, trendsAreStale } from "@/lib/ads/trending";

export const metadata = {
  title: "Trending topics — what the open web is writing about this week",
  description:
    "The subjects independent blogs and news sites are writing about more than they were last week, measured across hundreds of thousands of feeds and updated daily.",
  alternates: { canonical: "/trending" },
  openGraph: {
    title: "Trending topics on the open web",
    description: "What blogs and news sites are writing about more than they were last week.",
    url: "/trending",
  },
};

// The source moves once a day, so an hour is plenty fresh.
export const revalidate = 3600;

const LIMIT = 50;

function change(now: number, before: number): string {
  if (before === 0) return "new";
  const ratio = now / before;
  return ratio >= 10 ? `${Math.round(ratio)}x` : `${ratio.toFixed(1)}x`;
}

function updated(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function TrendingPage() {
  const topics = await currentTrends(serviceClient(), { limit: LIMIT, includeStale: true });
  const newest = topics.reduce<string | null>(
    (latest, topic) => (!latest || (topic.ingestedAt ?? "") > latest ? (topic.ingestedAt ?? latest) : latest),
    null,
  );
  const stale = topics.length > 0 && trendsAreStale(newest);

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <h1 className="text-3xl font-bold tracking-tight">Trending topics</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        What people are writing and searching for more than they were last week: subjects in the
        headlines of a sample of{" "}
        <a href="https://rssamp.com" className="underline">
          RSSAmp
        </a>
        &apos;s English blogs and news sites, mixed with searches people voted on at{" "}
        <a href="https://pit.world" className="underline">
          pit.world
        </a>
        . Read it as movement rather than a census.
      </p>

      {stale && newest && (
        <p className="card mt-6 p-3 text-sm text-[var(--color-muted)]">
          This list is from {updated(newest)} and is out of date, so it is not steering any ads right now.
        </p>
      )}

      {topics.length === 0 ? (
        <p className="card mt-8 p-5 text-sm text-[var(--color-muted)]">
          The first weekly comparison is still being worked out. Check back shortly.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Subject</th>
                <th className="py-2 pr-3 text-right font-medium">Mentions, {TREND_WINDOW_DAYS}d</th>
                <th className="py-2 pr-3 text-right font-medium">Week before</th>
                <th className="py-2 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((topic, index) => (
                <tr key={topic.topic} className="border-b border-[var(--color-border)]">
                  <td className="py-2 pr-3 text-[var(--color-muted)]">{index + 1}</td>
                  <td className="py-2 pr-3 font-medium">{topic.label ?? topic.topic}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{topic.mentions}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{topic.priorMentions}</td>
                  <td className="py-2 text-right tabular-nums">{change(topic.mentions, topic.priorMentions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            {newest && `Updated ${updated(newest)}. `}Also as{" "}
            <a href="/api/trending" className="underline">
              JSON
            </a>{" "}
            and the <code>list_trending_topics</code> MCP tool.
          </p>
        </div>
      )}

      <div className="card mt-10 p-5">
        <h2 className="font-semibold">Run ads where these subjects are read</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Trending targeting prefers your campaign on pages about a subject that is moving, when your own
          page is about it too.
        </p>
        <Link href="/dashboard/ads/new" className="btn btn-primary mt-3 inline-block">
          Create an ad
        </Link>
      </div>
    </div>
  );
}
