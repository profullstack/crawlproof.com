import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RetryButton } from "../../actions";

export const metadata = { title: "Autoblog · Article" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function AutoblogArticlePage({
  params,
}: {
  params: Promise<{ id: string; articleId: string }>;
}) {
  const { id: projectId, articleId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: article } = await supabase
    .from("lx_article")
    .select(
      "id, title, slug, meta_description, content_html, image_url, tags, internal_links, status, published_at, created_at, webhook_response_code, webhook_attempts, webhook_last_error, webhook_delivery_id, lx_site!inner(user_id, project_id, domain, blog_root_url)",
    )
    .eq("id", articleId)
    .maybeSingle();
  if (
    !article ||
    (article as any).lx_site?.user_id !== user.id ||
    (article as any).lx_site?.project_id !== projectId
  ) {
    notFound();
  }

  const site = (article as any).lx_site as {
    domain: string;
    blog_root_url: string;
  };
  const internalLinks: Array<{ url: string; title: string }> =
    (article.internal_links as any) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/projects/${projectId}/autoblog/history`}
          className="text-sm text-[var(--color-muted)]"
        >
          ← Article history
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold">{article.title}</h1>
          <span
            className={
              "badge " +
              (article.status === "published"
                ? "badge-pass"
                : article.status === "failed"
                  ? "badge-fail"
                  : "badge-warn")
            }
          >
            {article.status}
          </span>
        </div>
        <p className="text-sm text-[var(--color-muted)]">
          <code className="font-mono text-xs">{article.slug}</code> ·{" "}
          {article.published_at
            ? `published ${fmtDate(article.published_at)}`
            : `created ${fmtDate(article.created_at)}`}
        </p>
      </header>

      {/* Featured image */}
      {article.image_url && (
        <div className="overflow-hidden rounded border border-[var(--color-border)]">
          {/* External public URL from Supabase Storage. Next/Image with
              unoptimized to avoid the loader on third-party hosts. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.image_url}
            alt={article.title}
            className="block w-full"
          />
        </div>
      )}

      {/* Meta description */}
      <section className="card p-4">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Meta description
        </h2>
        <p className="mt-2 text-sm">{article.meta_description}</p>
      </section>

      {/* Delivery details */}
      <section className="card p-4 text-sm">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Delivery
        </h2>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-[var(--color-muted)]">Status</dt>
          <dd>
            {article.status}
            {article.webhook_response_code && (
              <span className="ml-2 text-xs text-[var(--color-muted)]">
                HTTP {article.webhook_response_code}
              </span>
            )}
          </dd>
          <dt className="text-[var(--color-muted)]">Attempts</dt>
          <dd>{article.webhook_attempts}</dd>
          <dt className="text-[var(--color-muted)]">Delivery ID</dt>
          <dd className="break-all font-mono text-xs">
            {article.webhook_delivery_id ?? "—"}
          </dd>
          {article.webhook_last_error && (
            <>
              <dt className="text-[var(--color-muted)]">Last error</dt>
              <dd className="break-words text-[var(--color-fail)]">
                {article.webhook_last_error}
              </dd>
            </>
          )}
        </dl>
        {article.status === "failed" && (
          <div className="mt-3">
            <RetryButton articleId={article.id} />
          </div>
        )}
      </section>

      {/* Internal links + tags */}
      {(internalLinks.length > 0 || (article.tags ?? []).length > 0) && (
        <section className="card p-4">
          {internalLinks.length > 0 && (
            <>
              <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Internal links inserted ({internalLinks.length})
              </h2>
              <ul className="mt-2 space-y-1 text-sm">
                {internalLinks.map((l) => (
                  <li key={l.url}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {l.title || l.url}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(article.tags ?? []).length > 0 && (
            <div className={internalLinks.length > 0 ? "mt-4" : ""}>
              <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Tags
              </h2>
              <div className="mt-2 flex flex-wrap gap-1">
                {(article.tags as string[]).map((t) => (
                  <span key={t} className="badge">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Rendered body */}
      <section className="prose prose-invert max-w-none">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Rendered article
        </h2>
        <div
          className="mt-2 rounded border border-[var(--color-border)] p-4 text-sm leading-relaxed [&_a]:underline [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:font-bold [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: article.content_html }}
        />
      </section>

      <p className="text-xs text-[var(--color-muted)]">
        Hosted at{" "}
        <a
          href={`${site.blog_root_url.replace(/\/$/, "")}/${article.slug}`}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {site.blog_root_url.replace(/\/$/, "")}/{article.slug}
        </a>{" "}
        once your receiver writes it (we don't host the public copy).
      </p>
    </div>
  );
}
