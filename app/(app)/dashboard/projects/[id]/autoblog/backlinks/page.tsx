import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getProjectById } from "@/lib/lx/currentSite";
import { BacklinkTrend, type BacklinkTrendPoint } from "./chart";

export const metadata = { title: "Autoblog · Backlinks" };

function fmtDate(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function publicPostUrl(
  site: { blog_root_url?: string | null } | null | undefined,
  article: { slug?: string | null } | null | undefined,
): string | null {
  const root = site?.blog_root_url?.replace(/\/$/, "");
  const slug = article?.slug;
  if (!root || !slug) return null;
  return `${root}/${slug}`;
}

function publicSiteUrl(site: { domain?: string | null } | null | undefined): string | null {
  return site?.domain ? `https://${site.domain}` : null;
}

function ExternalPostLink({
  url,
  label = "View post",
}: {
  url: string | null;
  label?: string;
}) {
  if (!url) return <span className="text-[var(--color-muted)]">-</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
    >
      {label} ↗
    </a>
  );
}

function dayKey(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function buildTrend(input: {
  incomingBacklinks: Array<{ created_at: string | null }>;
  outgoingBacklinks: Array<{ created_at: string | null }>;
  outgoingGuestPosts: Array<{ published_at: string | null; created_at: string | null }>;
  hostedGuestPosts: Array<{ published_at: string | null; created_at: string | null }>;
}): BacklinkTrendPoint[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const points: BacklinkTrendPoint[] = [];
  const byDate = new Map<string, BacklinkTrendPoint>();

  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const point = { date, incoming: 0, outgoing: 0, guestWritten: 0, guestHosted: 0 };
    points.push(point);
    byDate.set(date, point);
  }

  for (const row of input.incomingBacklinks) {
    const point = byDate.get(dayKey(row.created_at) ?? "");
    if (point) point.incoming += 1;
  }
  for (const row of input.outgoingBacklinks) {
    const point = byDate.get(dayKey(row.created_at) ?? "");
    if (point) point.outgoing += 1;
  }
  for (const row of input.outgoingGuestPosts) {
    const point = byDate.get(dayKey(row.published_at ?? row.created_at) ?? "");
    if (point) point.guestWritten += 1;
  }
  for (const row of input.hostedGuestPosts) {
    const point = byDate.get(dayKey(row.published_at ?? row.created_at) ?? "");
    if (point) point.guestHosted += 1;
  }

  return points;
}

function statusBadge(status: string) {
  return (
    <span
      className={
        "badge " +
        (status === "published"
          ? "badge-pass"
          : status === "failed"
            ? "badge-fail"
            : "badge-warn")
      }
    >
      {status}
    </span>
  );
}

export default async function AutoblogBacklinksPage({
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
    siteColumns: "id, domain, blog_root_url",
    projectColumns: "id, name, url",
  });
  if (!project) notFound();
  const site = project.lx_site as {
    id: string;
    domain: string;
    blog_root_url: string | null;
  } | null;
  if (!site) redirect(`/dashboard/projects/${projectId}/autoblog/setup`);
  const currentSitePublic = { blog_root_url: site.blog_root_url };

  const svc = serviceClient();
  const [
    { data: incomingBacklinks },
    { data: outgoingBacklinks },
    { data: outgoingGuestPosts },
    { data: hostedGuestPosts },
  ] = await Promise.all([
    svc
      .from("lx_backlink")
      .select(
        "id, target_url, anchor, created_at, giver_site:lx_site!lx_backlink_giver_site_id_fkey(id, domain, blog_root_url), giver_article:lx_article!lx_backlink_giver_article_id_fkey(id, title, slug, status, published_at, created_at)",
      )
      .eq("receiver_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(250),
    svc
      .from("lx_backlink")
      .select(
        "id, target_url, anchor, created_at, receiver_site:lx_site!lx_backlink_receiver_site_id_fkey(id, domain, blog_root_url), receiver_article:lx_article!lx_backlink_receiver_article_id_fkey(id, title, slug, status, published_at, created_at), giver_article:lx_article!lx_backlink_giver_article_id_fkey(id, title, slug, status, published_at, created_at)",
      )
      .eq("giver_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(250),
    svc
      .from("lx_article")
      .select(
        "id, title, slug, status, published_at, created_at, outbound_links, target_site:lx_site!lx_article_target_site_id_fkey(id, domain, blog_root_url)",
      )
      .eq("is_guest_post", true)
      .eq("author_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(250),
    svc
      .from("lx_article")
      .select(
        "id, title, slug, status, published_at, created_at, outbound_links, author_site:lx_site!lx_article_author_site_id_fkey(id, domain, blog_root_url)",
      )
      .eq("is_guest_post", true)
      .eq("target_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(250),
  ]);

  const incoming = (incomingBacklinks ?? []) as any[];
  const outgoing = (outgoingBacklinks ?? []) as any[];
  const guestWritten = (outgoingGuestPosts ?? []) as any[];
  const guestHosted = (hostedGuestPosts ?? []) as any[];
  const trend = buildTrend({
    incomingBacklinks: incoming,
    outgoingBacklinks: outgoing,
    outgoingGuestPosts: guestWritten,
    hostedGuestPosts: guestHosted,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link
          href={`/dashboard/projects/${projectId}/autoblog`}
          className="text-sm text-[var(--color-muted)]"
        >
          ← Autoblog
        </Link>
        <h1 className="mt-2 text-3xl font-bold">Backlinks</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {site.domain} · backlinks and guest posts
        </p>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm">
        <Link href={`/dashboard/projects/${projectId}/autoblog/history`} className="btn">
          History
        </Link>
        <Link href={`/dashboard/projects/${projectId}/autoblog/backlinks`} className="btn btn-primary">
          Backlinks
        </Link>
        <Link href={`/dashboard/projects/${projectId}/autoblog/setup`} className="btn">
          Settings
        </Link>
      </nav>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Incoming backlinks" value={incoming.length} />
        <Stat label="Outgoing backlinks" value={outgoing.length} />
        <Stat label="Guest posts written" value={guestWritten.length} />
        <Stat label="Guest posts hosted" value={guestHosted.length} />
      </section>

      <BacklinkTrend data={trend} />

      <section className="space-y-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Backlinks from other sites
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Network articles that link back to {site.domain}.
          </p>
        </div>
        {incoming.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No incoming backlinks recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <tr>
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Post</th>
                  <th className="py-2 pr-4">Anchor</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {incoming.map((b) => {
                  const postUrl = publicPostUrl(b.giver_site, b.giver_article);
                  return (
                    <tr key={b.id} className="align-top">
                      <td className="py-3 pr-4">
                        <a
                          href={publicSiteUrl(b.giver_site) ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {b.giver_site?.domain ?? "Partner site"}
                        </a>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="font-medium">
                          {b.giver_article?.title ?? "Untitled post"}
                        </div>
                        <div className="mt-1">
                          <ExternalPostLink url={postUrl} />
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-xs text-[var(--color-muted)]">
                        {b.anchor ?? "-"}
                      </td>
                      <td className="py-3 pr-4 text-xs">
                        <a
                          href={b.target_url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all underline"
                        >
                          {b.target_url}
                        </a>
                      </td>
                      <td className="py-3 text-xs text-[var(--color-muted)]">
                        {fmtDate(b.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Backlinks placed by your articles
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Links your generated posts placed to partner articles.
          </p>
        </div>
        {outgoing.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No outgoing exchange backlinks recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
                <tr>
                  <th className="py-2 pr-4">Your post</th>
                  <th className="py-2 pr-4">Partner</th>
                  <th className="py-2 pr-4">Target URL</th>
                  <th className="py-2">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {outgoing.map((b) => {
                  const yourPostUrl = publicPostUrl(currentSitePublic, b.giver_article);
                  return (
                    <tr key={b.id} className="align-top">
                      <td className="py-3 pr-4">
                        <div className="font-medium">
                          {b.giver_article?.title ?? "Untitled post"}
                        </div>
                        <div className="mt-1">
                          <ExternalPostLink url={yourPostUrl} />
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        {b.receiver_site?.domain ?? "Partner site"}
                      </td>
                      <td className="py-3 pr-4 text-xs">
                        <a
                          href={b.target_url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all underline"
                        >
                          {b.anchor ?? b.target_url}
                        </a>
                      </td>
                      <td className="py-3 text-xs text-[var(--color-muted)]">
                        {fmtDate(b.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Guest posts
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Posts you wrote for partner sites and partner posts hosted on your site.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <GuestPostList
            title="Written by you"
            empty="No outgoing guest posts yet."
            rows={guestWritten}
            renderMeta={(a) =>
              `Hosted by ${a.target_site?.domain ?? "partner"} · ${
                a.published_at ? fmtDate(a.published_at) : fmtDate(a.created_at)
              }`
            }
            renderUrl={(a) => publicPostUrl(a.target_site, a)}
          />
          <GuestPostList
            title="Hosted by you"
            empty="No partner guest posts hosted yet."
            rows={guestHosted}
            renderMeta={(a) =>
              `Author ${a.author_site?.domain ?? "partner"} · ${
                a.published_at ? fmtDate(a.published_at) : fmtDate(a.created_at)
              }`
            }
            renderUrl={(a) => publicPostUrl(currentSitePublic, a)}
          />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function GuestPostList({
  title,
  empty,
  rows,
  renderMeta,
  renderUrl,
}: {
  title: string;
  empty: string;
  rows: any[];
  renderMeta: (row: any) => string;
  renderUrl: (row: any) => string | null;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{empty}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
          {rows.map((a) => (
            <li key={a.id} className="p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{a.title}</div>
                  <div className="mt-1 text-xs text-[var(--color-muted)]">
                    {renderMeta(a)}
                  </div>
                </div>
                {statusBadge(a.status)}
              </div>
              <div className="mt-2">
                <ExternalPostLink url={renderUrl(a)} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
