import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/lib/lx/currentSite";
import { DashboardActions } from "./actions";
import { GuestPostOpportunities } from "./guest-posts";
import { Countdown } from "./countdown";
import { checkAutoblogReadiness, readinessLabel } from "@/lib/lx/readiness";
import { DeleteAutoblogButton } from "./delete-autoblog-button";
import { AutoblogAutoRefresh } from "./auto-refresh";

export const metadata = { title: "Autoblog" };

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function startOfMonthIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export default async function AutoblogDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const project = await getProjectById(projectId, {
    siteColumns:
      "id, domain, status, sitemap_status, last_sitemap_fetch_at, publish_days, publish_hour, daily_article_count, next_publish_at, webhook_url",
    projectColumns: "id, name, url",
  });
  if (!project) notFound();
  const site = project.lx_site as
    | {
        id: string;
        domain: string;
        status: string;
        sitemap_status: string | null;
        last_sitemap_fetch_at: string | null;
        publish_days: number[];
        publish_hour: number;
        daily_article_count: number;
        next_publish_at: string | null;
        webhook_url: string | null;
      }
    | null;

  if (!site) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-3xl font-bold">Autoblog</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          You haven't set up Autoblog yet for this project.
        </p>
        <Link
          href={`/projects/${projectId}/autoblog/setup`}
          className="btn btn-primary mt-4 inline-flex"
        >
          Get started
        </Link>
      </div>
    );
  }

  const monthStart = startOfMonthIso();
  const readinessPromise = checkAutoblogReadiness();
  const [
    { count: queuedKeywords },
    { count: failedKeywords },
    { count: publishedThisMonth },
    { count: failedArticles },
    { data: upcoming },
    { data: recent },
    { data: previews },
    { data: inFlight },
    { data: latestKeywordFailure },
  ] = await Promise.all([
    supabase
      .from("lx_keyword")
      .select("id", { count: "exact", head: true })
      .eq("site_id", site.id)
      .eq("status", "queued"),
    supabase
      .from("lx_keyword")
      .select("id", { count: "exact", head: true })
      .eq("site_id", site.id)
      .eq("status", "failed"),
    supabase
      .from("lx_article")
      .select("id", { count: "exact", head: true })
      .eq("site_id", site.id)
      .eq("status", "published")
      .gte("published_at", monthStart),
    supabase
      .from("lx_article")
      .select("id", { count: "exact", head: true })
      .eq("site_id", site.id)
      .eq("status", "failed"),
    supabase
      .from("lx_keyword")
      .select("id, keyword, scheduled_for, status, search_volume")
      .eq("site_id", site.id)
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true })
      .limit(30),
    supabase
      .from("lx_article")
      .select(
        "id, title, slug, status, published_at, webhook_response_code, webhook_last_error, created_at",
      )
      .eq("site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("lx_article")
      .select("id, title, slug, created_at")
      .eq("site_id", site.id)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(10),
    // Keywords actively being turned into articles. The autoblog worker
    // sets status='generating' the moment it claims a keyword and only
    // flips it off ('published' on success, 'failed' on error) once
    // generation resolves. Surfacing this count lets the page show a
    // live in-flight indicator instead of looking identical pre- and
    // post-click.
    supabase
      .from("lx_keyword")
      .select("id, keyword")
      .eq("site_id", site.id)
      .eq("status", "generating")
      .order("scheduled_for", { ascending: true }),
    supabase
      .from("lx_keyword")
      .select("keyword, created_at")
      .eq("site_id", site.id)
      .eq("status", "failed")
      .ilike("keyword", "Keyword research failed:%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const inFlightCount = (inFlight ?? []).length;

  const readiness = await readinessPromise;

  const publishDayLabels = (site.publish_days as number[])
    .map((n) => DAY_NAMES[n - 1])
    .filter(Boolean)
    .join(", ");

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Autoblog</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {site.domain}{" "}
            <span
              className={
                "badge ml-2 " +
                (site.status === "active"
                  ? "badge-pass"
                  : site.status === "paused"
                    ? "badge-warn"
                    : "badge-fail")
              }
            >
              {site.status}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/projects/${projectId}/autoblog/setup`} className="btn">
            Settings
          </Link>
          <Link href={`/projects/${projectId}/autoblog/history`} className="btn">
            History
          </Link>
          <Link href={`/projects/${projectId}/autoblog/backlinks`} className="btn">
            Backlinks
          </Link>
        </div>
      </header>

      {!readiness.ok && (
        <section className="rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5 p-4">
          <h2 className="text-sm font-bold text-[var(--color-warn)]">
            Some features are unavailable
          </h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Your environment is missing one or more credentials. Fix these in
            your deploy config; the rest of Autoblog will keep working.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {readiness.issues.map((iss) => (
              <li key={iss.key}>
                <span className="font-mono text-xs text-[var(--color-warn)]">
                  {readinessLabel(iss.key)}
                </span>
                <span className="ml-2 text-xs text-[var(--color-muted)]">
                  blocks: {iss.blocks.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Generated articles awaiting Publish — always visible so the
         user has a known destination after clicking Generate. Shows three
         distinct states so the page is the source of truth post-click
         instead of relying on a client-side poller: in-flight (keyword
         claimed by worker), previews ready, or empty. AutoblogAutoRefresh
         re-fetches on an interval while anything is in flight so the page
         transitions to "ready" without a manual reload. */}
      <AutoblogAutoRefresh active={inFlightCount > 0} />
      <section className="rounded border border-amber-500/40 bg-amber-500/5 p-4">
        <h2 className="text-sm font-bold text-amber-600 dark:text-amber-400">
          {(previews ?? []).length > 0
            ? `⚠ ${previews!.length} preview${previews!.length === 1 ? "" : "s"} waiting on Publish`
            : inFlightCount > 0
              ? `⏳ ${inFlightCount} generating now`
              : "Previews waiting on Publish"}
        </h2>
        {(previews ?? []).length > 0 ? (
          <>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              These articles have been generated but not yet delivered to
              your webhook. Open one to review, then click Publish to send it.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {previews!.map((p: any) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${projectId}/autoblog/articles/${p.id}`}
                    className="font-medium hover:underline"
                  >
                    {p.title}
                  </Link>
                  <span className="ml-2 text-xs text-[var(--color-muted)]">
                    {new Date(p.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
            {inFlightCount > 0 && (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Plus {inFlightCount} more generating — this page will refresh
                when {inFlightCount === 1 ? "it lands" : "they land"}.
              </p>
            )}
          </>
        ) : inFlightCount > 0 ? (
          <>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Generation takes 1–3 minutes (LLM + image + embeddings). This
              page is auto-refreshing — the preview link will appear here
              the moment it's ready.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {(inFlight ?? []).map((k: any) => (
                <li key={k.id} className="text-[var(--color-muted)]">
                  <span className="font-medium text-[var(--foreground)]">
                    {k.keyword}
                  </span>{" "}
                  <span className="badge badge-warn ml-1">generating</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            No previews yet. Click <em>Generate article now</em> below to
            produce one — it usually takes 1–3 minutes. The preview will
            appear here automatically when it's ready.
          </p>
        )}
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Published / month" value={publishedThisMonth ?? 0} />
        <Stat label="Queued keywords" value={queuedKeywords ?? 0} />
        <Stat
          label="Failed deliveries"
          value={failedArticles ?? 0}
          tone={(failedArticles ?? 0) > 0 ? "warn" : undefined}
        />
        <Stat
          label="Next publish"
          value={<Countdown targetIso={site.next_publish_at} />}
          small
        />
      </section>

      {/* Operational status */}
      <section className="card p-4 text-sm">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Status
        </h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          <Row k="Schedule">
            {site.daily_article_count}× / day, {publishDayLabels || "no days"} @{" "}
            {String(site.publish_hour).padStart(2, "0")}:00 UTC
          </Row>
          <Row k="Webhook">
            {site.webhook_url ? (
              <code className="break-all font-mono text-xs">
                {site.webhook_url}
              </code>
            ) : (
              <span className="text-[var(--color-fail)]">not configured</span>
            )}
          </Row>
          <Row k="Sitemap">
            {site.sitemap_status ?? "never crawled"}
            <span className="ml-2 text-xs text-[var(--color-muted)]">
              {fmtDate(site.last_sitemap_fetch_at)}
            </span>
          </Row>
          <Row k="Keyword research">
            {latestKeywordFailure ? (
              <span className="text-[var(--color-fail)]">
                {String((latestKeywordFailure as any).keyword).replace(
                  /^Keyword research failed:\s*/,
                  "",
                )}
              </span>
            ) : (
              <span className="text-[var(--color-muted)]">
                {queuedKeywords && queuedKeywords > 0
                  ? `${queuedKeywords} queued`
                  : "no recent errors"}
              </span>
            )}
          </Row>
        </dl>
        <DashboardActions
          paused={site.status === "paused"}
          projectId={projectId}
          queuedCount={queuedKeywords ?? 0}
          failedCount={failedKeywords ?? 0}
        />
      </section>

      <GuestPostOpportunities projectId={projectId} />

      {/* Upcoming */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Upcoming queue
        </h2>
        {(upcoming ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No keywords queued. Click "Generate keywords" above to seed the calendar.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {upcoming!.map((k: any) => (
              <li
                key={k.id}
                className="flex items-center justify-between px-3 py-2 text-sm"
              >
                <span className="truncate">{k.keyword}</span>
                <span className="ml-3 shrink-0 text-xs text-[var(--color-muted)]">
                  {k.scheduled_for}{" "}
                  {k.search_volume ? `· vol ${k.search_volume}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent articles */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Recent articles
        </h2>
        {(recent ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No articles yet. Once a queued keyword's slot comes up, an article
            will generate and post automatically.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {recent!.map((a: any) => (
              <li key={a.id} className="px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    href={`/projects/${projectId}/autoblog/articles/${a.id}`}
                    className="truncate hover:underline"
                  >
                    {a.title}
                  </Link>
                  <ArticleBadge status={a.status} code={a.webhook_response_code} />
                </div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  {a.status === "published"
                    ? `Published ${fmtDate(a.published_at)}`
                    : `Created ${fmtDate(a.created_at)}`}
                  {a.webhook_last_error && (
                    <span className="ml-2 text-[var(--color-fail)]">
                      · {a.webhook_last_error}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Danger zone */}
      <section className="border-t border-[var(--color-border)] pt-4">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Danger zone
        </h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Removes the autoblog config (lx_site row) plus all queued
          keywords and article history for this project. The project
          itself stays — delete it separately from Overview.
        </p>
        <div className="mt-2">
          <DeleteAutoblogButton projectId={projectId} />
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  small,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  small?: boolean;
  tone?: "warn";
}) {
  return (
    <div className="card p-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div
        className={
          (small ? "mt-1 text-base" : "mt-1 text-2xl font-bold") +
          (tone === "warn" ? " text-[var(--color-warn)]" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {k}
      </dt>
      <dd>{children}</dd>
    </>
  );
}

function ArticleBadge({ status, code }: { status: string; code: number | null }) {
  if (status === "published") {
    return <span className="badge badge-pass">{code ?? "200"}</span>;
  }
  if (status === "failed") {
    return <span className="badge badge-fail">{code ?? "failed"}</span>;
  }
  if (status === "publishing" || status === "generating") {
    return <span className="badge badge-warn">{status}</span>;
  }
  return <span className="badge">{status}</span>;
}
