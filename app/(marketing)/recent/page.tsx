import type { Metadata } from "next";
import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const revalidate = 60;

const PAGE_SIZE = 20;
const MAX_PAGES = 5; // 100 most recent

type Row = {
  share_token: string | null;
  target_url: string;
  status: string;
  score: number | null;
  completed_at: string | null;
  created_at: string;
  engine: string | null;
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of Array.from(u.searchParams.keys())) {
      const normalized = key.toLowerCase();
      if (
        normalized.startsWith("utm_") ||
        [
          "fbclid",
          "gclid",
          "gbraid",
          "wbraid",
          "msclkid",
          "mc_cid",
          "mc_eid",
          "igshid",
          "li_fat_id",
          "ref",
        ].includes(normalized)
      ) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

function formatScore(score: number | null, status: string): string {
  if (status !== "complete" || score === null) return status;
  return `${score}/100`;
}

function scoreClass(score: number | null, status: string): string {
  if (status !== "complete" || score === null) return "badge-unknown";
  if (score >= 80) return "badge-pass";
  if (score >= 50) return "badge-warn";
  return "badge-fail";
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const page = Math.max(1, Math.min(MAX_PAGES, Number(sp.page) || 1));
  const url = `${env.siteUrl.replace(/\/$/, "")}/recent${page > 1 ? `?page=${page}` : ""}`;
  return {
    title:
      page === 1
        ? "Recent AEO audits"
        : `Recent AEO audits — page ${page}`,
    description:
      "Browse opted-in free AEO audits run on CrawlProof. See what AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) can find on real sites — score, findings, and a priority to-do list.",
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      url,
      title: "Recent AEO audits — CrawlProof",
      description:
        "The latest opted-in AEO audits run on CrawlProof. Free, anonymous scans of real sites.",
      siteName: "CrawlProof",
    },
    twitter: { card: "summary_large_image", title: "Recent AEO audits — CrawlProof" },
    robots: { index: true, follow: true },
  };
}

export default async function RecentPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Math.min(MAX_PAGES, Number(sp.page) || 1));
  const offset = (page - 1) * PAGE_SIZE;

  const svc = serviceClient();
  const { data, count } = await svc
    .from("audits")
    .select(
      "share_token, target_url, status, score, completed_at, created_at, engine",
      { count: "exact" },
    )
    .is("owner_id", null)
    .eq("listed_public", true)
    .eq("status", "complete")
    .not("share_token", "is", null)
    .order("completed_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const rows = (data ?? []) as Row[];
  const totalReachable = Math.min(count ?? 0, MAX_PAGES * PAGE_SIZE);
  const lastPage = Math.max(1, Math.min(MAX_PAGES, Math.ceil(totalReachable / PAGE_SIZE)));

  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "CrawlProof",
        item: env.siteUrl,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Recent audits",
        item: `${env.siteUrl.replace(/\/$/, "")}/recent`,
      },
    ],
  };
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: rows.map((r, i) => ({
      "@type": "ListItem",
      position: offset + i + 1,
      url: `${env.siteUrl.replace(/\/$/, "")}/r/${r.share_token}`,
      name: `AEO audit for ${hostOf(r.target_url)}`,
    })),
  };

  return (
    <main className="mx-auto max-w-4xl px-4 sm:px-6 py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbs) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />

      <header>
        <h1 className="text-4xl font-extrabold">Recent AEO audits</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          The most recent {MAX_PAGES * PAGE_SIZE}{" "}
          opted-in free scans run on CrawlProof.
          Click any to see the full report — what AI crawlers can find, what they can&apos;t,
          and the priority to-do list to fix it.
        </p>
        <p className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm text-[var(--color-muted)]">
          Privacy note: only scans explicitly listed by the submitter appear
          here. Common tracking parameters such as utm_* and fbclid are hidden
          from this list and stripped from new submissions before storage. Use
          a signed-in private project for private scan history.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="mt-10 text-[var(--color-muted)]">No completed scans yet.</p>
      ) : (
        <ul className="mt-10 space-y-2">
          {rows.map((r) => {
            const host = hostOf(r.target_url);
            const when = r.completed_at ?? r.created_at;
            return (
              <li key={r.share_token!} className="card p-4">
                <Link
                  href={`/r/${r.share_token}`}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{host}</div>
                    <div className="mt-1 truncate text-xs text-[var(--color-muted)]">
                      {displayUrl(r.target_url)}
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-muted)]">
                      {new Date(when).toLocaleString()}
                      {r.engine ? ` · ${r.engine}` : ""}
                    </div>
                  </div>
                  <span className={`badge ${scoreClass(r.score, r.status)}`}>
                    {formatScore(r.score, r.status)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <nav className="mt-10 flex items-center justify-between text-sm">
        {page > 1 ? (
          <Link href={page === 2 ? "/recent" : `/recent?page=${page - 1}`} className="btn">
            ← Previous
          </Link>
        ) : (
          <span />
        )}
        <span className="text-[var(--color-muted)]">
          Page {page} of {lastPage}
        </span>
        {page < lastPage ? (
          <Link href={`/recent?page=${page + 1}`} className="btn">
            Next →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
}
