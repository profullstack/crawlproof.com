import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { serviceClient } from "@/lib/supabase/service";
import { rankRows, readBatch } from "@/lib/batch-audits";

export const revalidate = 300;

type Ranking = {
  slug: string;
  title: string;
  list_name: string;
  method: string;
  batch_id: string;
  published_at: string | null;
};

async function loadRanking(slug: string): Promise<Ranking | null> {
  const { data } = await serviceClient()
    .from("rankings")
    .select("slug, title, list_name, method, batch_id, published_at")
    .eq("slug", slug)
    .not("published_at", "is", null)
    .maybeSingle();
  return (data as Ranking | null) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const r = await loadRanking(slug);
  if (!r) return { title: "Ranking not found", robots: { index: false } };
  return {
    title: r.title,
    description: `${r.list_name}, ranked by how well AI crawlers and answer engines can read each site. Scores out of 100 from the CrawlProof AI-visibility audit, with a public report for every site.`,
    alternates: { canonical: `/rankings/${r.slug}` },
  };
}

function day(iso: string | null): string {
  return iso ? new Date(iso).toUTCString().slice(5, 16) : "";
}

export default async function RankingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ranking = await loadRanking(slug);
  if (!ranking) notFound();
  const rows = rankRows((await readBatch(ranking.batch_id)).filter((r) => r.status === "complete"));
  const lastRun = rows.reduce<string | null>(
    (max, r) => (r.completed_at && (!max || r.completed_at > max) ? r.completed_at : max),
    null,
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <p className="text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">AI-visibility ranking</p>
      <h1 className="mt-2 text-balance text-3xl font-extrabold sm:text-4xl">{ranking.title}</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        {rows.length} sites from {ranking.list_name}. Audited {day(lastRun ?? ranking.published_at)}.
      </p>

      <div className="card mt-8 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Site</th>
              <th className="px-4 py-3 text-right">Score</th>
              <th className="hidden px-4 py-3 sm:table-cell">Biggest issue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.target_url} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-4 py-3 text-[var(--color-muted)]">{i + 1}</td>
                <td className="px-4 py-3">
                  <Link href={`/r/${r.token}?src=ranking`} className="font-semibold hover:underline">
                    {r.domain}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right font-mono font-bold">{r.score ?? "–"}</td>
                <td className="hidden px-4 py-3 text-[var(--color-muted)] sm:table-cell">{r.top_issue || "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-10 space-y-6">
        <div>
          <h2 className="text-lg font-bold">Method</h2>
          <p className="mt-2 whitespace-pre-line text-[var(--color-muted)]">{ranking.method}</p>
        </div>
        <div>
          <h2 className="text-lg font-bold">Listed here? Dispute or update your entry</h2>
          <p className="mt-2 text-[var(--color-muted)]">
            Every score links to its full report, with each check and what it found. If something
            is wrong, or you have fixed it, email{" "}
            <a href={`mailto:hello@crawlproof.com?subject=${encodeURIComponent(`Ranking: ${ranking.slug}`)}`} className="text-[var(--color-accent)] hover:underline">
              hello@crawlproof.com
            </a>{" "}
            with the site name. We re-run the audit and update the table, usually within a day.
          </p>
        </div>
        <div className="card p-6">
          <h2 className="text-lg font-bold">Check your own site</h2>
          <p className="mt-2 text-[var(--color-muted)]">The same audit is free, with no signup.</p>
          <Link href="/#audit" className="btn btn-primary mt-4">
            Run a free audit
          </Link>
        </div>
      </section>
    </main>
  );
}
