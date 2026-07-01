import type { Metadata } from "next";
import Link from "next/link";
import { serviceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { listUserOrgs } from "@/lib/orgs";
import { RecentOutreachForm, type OutreachHistoryItem } from "./outreach-form";

export const dynamic = "force-dynamic";
export const revalidate = 60;

const PAGE_SIZE = 20;
const MAX_PAGES = 5; // 100 most recent

type Row = {
  id: string;
  share_token: string | null;
  target_url: string;
  status: string;
  score: number | null;
  completed_at: string | null;
  created_at: string;
  engine: string | null;
  pdf_email: string | null;
  phone: string | null;
};

type SocialAccount = {
  id: string;
  platform: string;
  handle: string;
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
        "The latest opted-in AEO audits run on CrawlProof. Shareable scans of real sites.",
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
      "id, share_token, target_url, status, score, completed_at, created_at, engine, pdf_email, phone",
      { count: "exact" },
    )
    .eq("listed_public", true)
    .eq("status", "complete")
    .not("share_token", "is", null)
    .order("completed_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const rows = (data ?? []) as Row[];
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const outreach = user ? await firstOwnedOrg(supabase, user.id) : null;
  const socialAccounts = user && outreach ? await listSocialAccounts(supabase, user.id) : [];
  const historyByAudit =
    outreach && rows.length > 0
      ? await fetchOutreachHistory(
          supabase,
          outreach.org.id,
          rows.map((r) => r.id),
        )
      : new Map<string, OutreachHistoryItem[]>();
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
          opted-in scans run on CrawlProof.
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
                {outreach && (
                  <RecentOutreachForm
                    auditId={r.id}
                    organizationId={outreach.org.id}
                    host={host}
                    hasEmail={!!r.pdf_email}
                    hasPhone={!!r.phone}
                    socialAccounts={socialAccounts}
                    creditsBalance={outreach.creditsBalance}
                    history={historyByAudit.get(r.id) ?? []}
                  />
                )}
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

async function listSocialAccounts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<SocialAccount[]> {
  const { data, error } = await supabase
    .from("sp_account")
    .select("id, platform, handle")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) return [];
  return ((data ?? []) as unknown) as SocialAccount[];
}

// Outreach UX is shown to every org owner; sending is metered by credits, so
// we surface the owner's balance and let the form prompt a top-up when low.
async function firstOwnedOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
) {
  const orgs = await listUserOrgs(supabase, userId);
  const owned =
    orgs.find((org) => org.role === "owner" && org.name.toLowerCase() === "prospects") ??
    orgs.find((org) => org.role === "owner");
  if (!owned) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits_balance")
    .eq("id", userId)
    .maybeSingle();
  const creditsBalance =
    (profile?.credits_balance as number | null | undefined) ?? 0;
  return { org: owned, creditsBalance };
}

// Per-audit outreach send history for this org (most recent first). Social
// rows embed the published post URL via the social_post_id FK.
async function fetchOutreachHistory(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  auditIds: string[],
): Promise<Map<string, OutreachHistoryItem[]>> {
  const byAudit = new Map<string, OutreachHistoryItem[]>();
  const { data } = await supabase
    .from("recent_outreach_messages")
    .select(
      "id, audit_id, channel, provider, status, subject, error, created_at, social_post:sp_post(status, platform_post_url, last_error)",
    )
    .eq("organization_id", organizationId)
    .in("audit_id", auditIds)
    .order("created_at", { ascending: false });

  for (const row of (data ?? []) as Array<{
    id: string;
    audit_id: string;
    channel: string;
    provider: string;
    status: "sent" | "failed" | "queued";
    subject: string | null;
    error: string | null;
    created_at: string;
    social_post:
      | SocialPostRow
      | SocialPostRow[]
      | null;
  }>) {
    const post = Array.isArray(row.social_post)
      ? row.social_post[0] ?? null
      : row.social_post;
    const derived = deriveOutreachStatus(row.status, row.error, row.created_at, post);
    const item: OutreachHistoryItem = {
      id: row.id,
      channel: row.channel,
      provider: row.provider,
      status: derived.status,
      subject: row.subject,
      error: derived.error,
      createdAt: row.created_at,
      url: post?.platform_post_url ?? null,
    };
    const list = byAudit.get(row.audit_id) ?? [];
    list.push(item);
    byAudit.set(row.audit_id, list);
  }
  return byAudit;
}

type SocialPostRow = {
  status: string | null;
  platform_post_url: string | null;
  last_error: string | null;
};

// A browser-automated post (auth_mode='cookie') is stuck in the worker
// queue longer than this before we surface it as timed out. Playwright
// posts normally finish in well under a minute.
const OUTREACH_STALE_MS = 20 * 60 * 1000;

// The outreach row's own status is only accurate for the synchronous
// (OAuth) path. Cookie-auth posts are handed to the Playwright worker and
// recorded as "queued"; the worker updates the linked sp_post but never
// the outreach row. Derive the real status from that sp_post at read time
// so the history reflects what actually happened — and expire jobs that
// never came back.
function deriveOutreachStatus(
  rowStatus: "sent" | "failed" | "queued",
  rowError: string | null,
  createdAt: string,
  post: SocialPostRow | null,
): { status: OutreachHistoryItem["status"]; error: string | null } {
  // Terminal statuses from the synchronous path are authoritative.
  if (rowStatus !== "queued") return { status: rowStatus, error: rowError };
  // Manual "queued for hand-delivery" rows have no linked post.
  if (!post) return { status: "queued", error: rowError };

  if (post.status === "published") return { status: "sent", error: null };
  if (post.status === "failed" || post.status === "cancelled") {
    return { status: "failed", error: post.last_error ?? rowError };
  }
  // Still queued_browser / publishing — flip to timed out once stale.
  if (Date.now() - new Date(createdAt).getTime() > OUTREACH_STALE_MS) {
    return {
      status: "timed_out",
      error: "The worker never reported back — the post may not have been published.",
    };
  }
  return { status: "queued", error: rowError };
}
