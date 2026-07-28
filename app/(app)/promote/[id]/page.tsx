import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { cadenceLabel } from "@/lib/promote/generatePitch";
import { PromoteListActions } from "@/components/promote/list-actions";
import { PromoteRealtime } from "@/components/promote/promote-realtime";
import { PromoteEditForm } from "@/components/promote/promote-edit-form";
import { AddLinksForm } from "@/components/promote/add-links-form";
import { LinkList } from "@/components/promote/link-list";

export const metadata = { title: "Promote list" };

type Props = { params: Promise<{ id: string }> };

export default async function PromoteDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: list } = await supabase
    .from("promo_list")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!list) notFound();

  const [{ data: links }, { data: posts }, { data: accounts }] = await Promise.all([
    supabase
      .from("promo_link")
      .select("id, url, title, angle, enabled, times_promoted, last_promoted_at, created_at")
      .eq("list_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("promo_post")
      .select("id, link_id, platform, body, status, error, credits_spent, posted_at, provider, external_post_id, post_url")
      .eq("list_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("sp_account")
      .select("id, platform, handle")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("platform"),
  ]);

  const linkRows = (links ?? []) as Array<{
    id: string;
    url: string;
    title: string | null;
    angle: string | null;
    enabled: boolean;
    times_promoted: number;
    last_promoted_at: string | null;
    created_at: string;
  }>;

  const postRows = (posts ?? []) as Array<{
    id: string;
    link_id: string;
    platform: string;
    body: string;
    status: string;
    error: string | null;
    credits_spent: number;
    posted_at: string | null;
    provider: string | null;
    external_post_id: string | null;
    post_url: string | null;
  }>;

  const accountRows = (accounts ?? []) as Array<{
    id: string;
    platform: string;
    handle: string;
  }>;

  const totalPosts = postRows.filter((p) => p.status === "posted").length;
  const totalCredits = postRows.reduce((sum, p) => sum + (p.credits_spent ?? 0), 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PromoteRealtime listId={list.id} />
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/promote" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]">
            &larr; All lists
          </Link>
          <h1 className="text-3xl font-bold">{list.name}</h1>
        </div>
        <PromoteListActions id={list.id} status={list.status} showEdit={false} />
      </div>

      {/* Status bar */}
      <div className="mt-4 flex flex-wrap gap-3">
        <span
          className={`badge ${
            list.status === "running"
              ? "badge-pass"
              : list.status === "paused"
                ? "badge-warn"
                : ""
          }`}
        >
          {list.status}
        </span>
        {list.pause_reason === "insufficient_credits" && (
          <Link href="/settings/billing" className="badge badge-fail">
            Low credits — buy more
          </Link>
        )}
        <span className="text-sm text-[var(--color-muted)]">
          {cadenceLabel(list.cadence_seconds)} · {list.post_mode} · {linkRows.length} link{linkRows.length !== 1 ? "s" : ""} · {totalPosts} posts · {totalCredits} credits spent
        </span>
      </div>

      {/* Edit form */}
      <section className="card mt-6 p-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <PromoteEditForm
          list={{
            id: list.id,
            name: list.name,
            cadence_seconds: list.cadence_seconds,
            post_mode: list.post_mode,
            brand_voice: list.brand_voice ?? "",
            target_account_ids: list.target_account_ids,
          }}
          accounts={accountRows}
        />
      </section>

      {/* Links */}
      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Links</h2>
        </div>
        <LinkList links={linkRows} />
        <div className="mt-4">
          <AddLinksForm listId={list.id} />
        </div>
      </section>

      {/* Recent posts */}
      <section className="mt-6">
        <h2 className="text-lg font-semibold">Recent posts</h2>
        {postRows.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">No posts yet. The first drip will fire shortly if the list is running.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {postRows.map((p) => (
              <li key={p.id} className="card p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-[var(--color-muted)]">{p.platform}</span>
                    <span
                      className={`badge text-xs ${
                        p.status === "posted" ? "badge-pass" : p.status === "failed" ? "badge-fail" : ""
                      }`}
                    >
                      {/* Cookie-auth posts land as 'pending' until the browser
                          worker publishes and reconciles the real outcome. */}
                      {p.status === "pending" ? "posting…" : p.status}
                    </span>
                    {p.provider && (
                      <span className="text-xs text-[var(--color-muted)]">via {p.provider}</span>
                    )}
                  </div>
                  <span className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
                    {p.posted_at ? new Date(p.posted_at).toLocaleString() : "—"}
                    {p.post_url && (
                      <a
                        href={p.post_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="whitespace-nowrap font-semibold text-[var(--color-accent)] hover:underline"
                      >
                        View post ↗
                      </a>
                    )}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[var(--color-fg)]">
                  {p.body.length > 300 ? p.body.slice(0, 300) + "..." : p.body}
                </p>
                {p.error && (
                  <p className="mt-1 text-xs text-[var(--color-fail)]">{p.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
