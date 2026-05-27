import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getProjectById } from "@/lib/lx/currentSite";
import { RetryButton, RepublishButton } from "../actions";

export const metadata = { title: "Autoblog · History" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
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
  if (!url) return <span className="text-[var(--color-muted)]">—</span>;
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

export default async function AutoblogHistoryPage({
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
  if (!site) redirect(`/projects/${projectId}/autoblog/setup`);
  const currentSitePublic = { blog_root_url: site.blog_root_url };

  const { data: articles } = await supabase
    .from("lx_article")
    .select(
      "id, title, slug, status, published_at, webhook_response_code, webhook_attempts, webhook_last_error, image_url, internal_links, tags, created_at",
    )
    .eq("site_id", site.id)
    .order("created_at", { ascending: false })
    .limit(50);

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
      .limit(100),
    svc
      .from("lx_backlink")
      .select(
        "id, target_url, anchor, created_at, receiver_site:lx_site!lx_backlink_receiver_site_id_fkey(id, domain, blog_root_url), receiver_article:lx_article!lx_backlink_receiver_article_id_fkey(id, title, slug, status, published_at, created_at), giver_article:lx_article!lx_backlink_giver_article_id_fkey(id, title, slug, status, published_at, created_at)",
      )
      .eq("giver_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(100),
    svc
      .from("lx_article")
      .select(
        "id, title, slug, status, published_at, created_at, outbound_links, target_site:lx_site!lx_article_target_site_id_fkey(id, domain, blog_root_url)",
      )
      .eq("is_guest_post", true)
      .eq("author_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(100),
    svc
      .from("lx_article")
      .select(
        "id, title, slug, status, published_at, created_at, outbound_links, author_site:lx_site!lx_article_author_site_id_fkey(id, domain, blog_root_url)",
      )
      .eq("is_guest_post", true)
      .eq("target_site_id", site.id)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}/autoblog`}
          className="text-sm text-[var(--color-muted)]"
        >
          ← Autoblog
        </Link>
        <h1 className="mt-2 text-3xl font-bold">History</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {site.domain} · articles, backlinks, and guest posts
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Article history
        </h2>
        {(articles ?? []).length === 0 ? (
          <p className="text-[var(--color-muted)]">No articles yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-4">Title</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Internal links</th>
                <th className="py-2 pr-4">Published</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {articles!.map((a: any) => (
                <tr key={a.id} className="align-top">
                  <td className="py-3 pr-4">
                    <Link
                      href={`/projects/${projectId}/autoblog/articles/${a.id}`}
                      className="font-medium hover:underline"
                    >
                      {a.title}
                    </Link>
                    <div className="text-xs text-[var(--color-muted)]">{a.slug}</div>
                    {a.webhook_last_error && a.status === "failed" && (
                      <div className="mt-1 text-xs text-[var(--color-fail)]">
                        {a.webhook_last_error}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={
                        "badge " +
                        (a.status === "published"
                          ? "badge-pass"
                          : a.status === "failed"
                            ? "badge-fail"
                            : "badge-warn")
                      }
                    >
                      {a.status}
                    </span>
                    {a.webhook_response_code && (
                      <div className="mt-1 text-xs text-[var(--color-muted)]">
                        HTTP {a.webhook_response_code} · {a.webhook_attempts}{" "}
                        attempt{a.webhook_attempts === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-xs text-[var(--color-muted)]">
                    {(a.internal_links ?? []).length}
                  </td>
                  <td className="py-3 pr-4 text-xs text-[var(--color-muted)]">
                    {a.published_at ? fmtDate(a.published_at) : "—"}
                  </td>
                  <td className="py-3">
                    {a.status === "failed" ? (
                      <RetryButton articleId={a.id} />
                    ) : a.status === "published" ? (
                      <RepublishButton articleId={a.id} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Backlinks from other sites
          </h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Network articles that link back to {site.domain}.
          </p>
        </div>
        {(incomingBacklinks ?? []).length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No incoming backlinks recorded yet.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
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
              {incomingBacklinks!.map((b: any) => {
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
                      {b.anchor ?? "—"}
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
        {(outgoingBacklinks ?? []).length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No outgoing exchange backlinks recorded yet.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-4">Your post</th>
                <th className="py-2 pr-4">Partner</th>
                <th className="py-2 pr-4">Target URL</th>
                <th className="py-2">Recorded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {outgoingBacklinks!.map((b: any) => {
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
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Written by you</h3>
            {(outgoingGuestPosts ?? []).length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">
                No outgoing guest posts yet.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
                {outgoingGuestPosts!.map((a: any) => {
                  const postUrl = publicPostUrl(a.target_site, a);
                  return (
                    <li key={a.id} className="p-3 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">{a.title}</div>
                          <div className="mt-1 text-xs text-[var(--color-muted)]">
                            Hosted by {a.target_site?.domain ?? "partner"} ·{" "}
                            {a.published_at ? fmtDate(a.published_at) : fmtDate(a.created_at)}
                          </div>
                        </div>
                        <span
                          className={
                            "badge " +
                            (a.status === "published"
                              ? "badge-pass"
                              : a.status === "failed"
                                ? "badge-fail"
                                : "badge-warn")
                          }
                        >
                          {a.status}
                        </span>
                      </div>
                      <div className="mt-2">
                        <ExternalPostLink url={postUrl} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Hosted by you</h3>
            {(hostedGuestPosts ?? []).length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">
                No partner guest posts hosted yet.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
                {hostedGuestPosts!.map((a: any) => {
                  const postUrl = publicPostUrl(currentSitePublic, a);
                  return (
                    <li key={a.id} className="p-3 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">{a.title}</div>
                          <div className="mt-1 text-xs text-[var(--color-muted)]">
                            Author {a.author_site?.domain ?? "partner"} ·{" "}
                            {a.published_at ? fmtDate(a.published_at) : fmtDate(a.created_at)}
                          </div>
                        </div>
                        <span
                          className={
                            "badge " +
                            (a.status === "published"
                              ? "badge-pass"
                              : a.status === "failed"
                                ? "badge-fail"
                                : "badge-warn")
                          }
                        >
                          {a.status}
                        </span>
                      </div>
                      <div className="mt-2">
                        <ExternalPostLink url={postUrl} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
