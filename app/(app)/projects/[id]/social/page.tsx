import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PostNowForm } from "./post-now";
import { FeedSettingsForm } from "./feed-settings";

export const metadata = { title: "Social" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function SocialDashboardPage({
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

  // Accounts are GLOBAL (per-user), shown across every project. Posts
  // are PROJECT-scoped so each project's social tab only shows its own
  // activity. A per-project override layer (sp_site_account) ships in
  // a later iteration.
  const [
    { data: accounts },
    { data: posts },
    { data: feedConfig },
    { data: bindings },
    { data: feedItems },
  ] = await Promise.all([
    supabase
      .from("sp_account")
      .select("id, platform, handle, status")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: false }),
    supabase
      .from("sp_post")
      .select(
        "id, account_id, rendered_text, source, status, published_at, platform_post_url, last_error, created_at",
      )
      .eq("user_id", user.id)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("sp_feed_config")
      .select(
        "enabled, feed_type, feed_url, ignore_paths, status, last_checked_at, last_success_at, last_item_at, last_error",
      )
      .eq("user_id", user.id)
      .eq("project_id", projectId)
      .maybeSingle(),
    supabase
      .from("sp_site_account")
      .select("account_id, auto, enabled")
      .eq("user_id", user.id)
      .eq("project_id", projectId),
    supabase
      .from("sp_feed_item")
      .select("id, url, title, status, first_seen_at, posted_at, last_error")
      .eq("user_id", user.id)
      .eq("project_id", projectId)
      .order("first_seen_at", { ascending: false })
      .limit(10),
  ]);

  const accountList = (accounts ?? []) as Array<{
    id: string;
    platform: string;
    handle: string;
    status: string;
  }>;
  const accountById = new Map(accountList.map((a) => [a.id, a]));
  const autopostAccountIds = ((bindings ?? []) as Array<{
    account_id: string;
    auto: boolean;
    enabled: boolean;
  }>)
    .filter((b) => b.auto && b.enabled)
    .map((b) => b.account_id);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Social</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Post to your connected accounts. v1 supports Bluesky; more
            platforms ship in subsequent phases.
          </p>
        </div>
        <Link href={`/projects/${projectId}/social/setup`} className="btn">
          Manage accounts
        </Link>
      </header>

      {accountList.length === 0 ? (
        <section className="card p-5">
          <p className="text-sm text-[var(--color-muted)]">
            No connected accounts yet.{" "}
            <Link href={`/projects/${projectId}/social/setup`} className="underline">
              Connect one
            </Link>{" "}
            to start posting.
          </p>
        </section>
      ) : (
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Post now</h2>
          <PostNowForm accounts={accountList} />
        </section>
      )}

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Feed autopost</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Watch a sitemap or RSS feed and post newly discovered URLs to
              selected accounts.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <FeedSettingsForm
            projectId={projectId}
            accounts={accountList}
            config={(feedConfig as any) ?? null}
            autopostAccountIds={autopostAccountIds}
          />
        </div>
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Feed history
        </h2>
        {(feedItems ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No feed items checked yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {feedItems!.map((item: any) => (
              <li key={item.id} className="px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="line-clamp-1 flex-1 font-medium hover:underline"
                  >
                    {item.title || item.url}
                  </a>
                  <span
                    className={
                      "badge shrink-0 " +
                      (item.status === "posted"
                        ? "badge-pass"
                        : item.status === "failed"
                          ? "badge-fail"
                          : "badge-warn")
                    }
                  >
                    {item.status}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  Seen {fmtDate(item.first_seen_at)}
                  {item.posted_at ? ` · posted ${fmtDate(item.posted_at)}` : ""}
                </div>
                {item.last_error && (
                  <p className="mt-1 text-xs text-[var(--color-fail)]">
                    {item.last_error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Recent posts
        </h2>
        {(posts ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No posts yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {posts!.map((p: any) => {
              const a = accountById.get(p.account_id);
              return (
                <li key={p.id} className="px-3 py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="line-clamp-2 flex-1">{p.rendered_text}</span>
                    <span
                      className={
                        "badge shrink-0 " +
                        (p.status === "published"
                          ? "badge-pass"
                          : p.status === "failed"
                            ? "badge-fail"
                            : "badge-warn")
                      }
                    >
                      {p.status}
                    </span>
                  </div>
                  <div className="mt-1 flex items-baseline gap-2 text-xs text-[var(--color-muted)]">
                    {a && (
                      <span>
                        {a.handle} <span className="opacity-60">({a.platform})</span>
                      </span>
                    )}
                    {p.source && (
                      <>
                        <span>·</span>
                        <span>{p.source}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>
                      {p.status === "published"
                        ? fmtDate(p.published_at)
                        : fmtDate(p.created_at)}
                    </span>
                    {p.platform_post_url && (
                      <>
                        <span>·</span>
                        <a
                          href={p.platform_post_url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          view
                        </a>
                      </>
                    )}
                  </div>
                  {p.last_error && p.status === "failed" && (
                    <p className="mt-1 text-xs text-[var(--color-fail)]">
                      {p.last_error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
