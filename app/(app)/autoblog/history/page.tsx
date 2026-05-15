import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RetryButton } from "../actions";

export const metadata = { title: "Autoblog · History" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function AutoblogHistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: site } = await supabase
    .from("lx_site")
    .select("id, domain")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!site) redirect("/autoblog/setup");

  const { data: articles } = await supabase
    .from("lx_article")
    .select(
      "id, title, slug, status, published_at, webhook_response_code, webhook_attempts, webhook_last_error, image_url, internal_links, tags, created_at",
    )
    .eq("site_id", site.id)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link href="/autoblog" className="text-sm text-[var(--color-muted)]">
          ← Autoblog
        </Link>
        <h1 className="mt-2 text-3xl font-bold">Article history</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {site.domain} · last 50 articles
        </p>
      </div>

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
                    href={`/autoblog/articles/${a.id}`}
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
                  {a.status === "failed" ? <RetryButton articleId={a.id} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
