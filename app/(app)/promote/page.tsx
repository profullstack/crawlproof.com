import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PromoteListActions } from "@/components/promote/list-actions";
import { cadenceLabel } from "@/lib/promote/generatePitch";

export const metadata = { title: "Promote" };

type ListRow = {
  id: string;
  name: string;
  status: string;
  cadence_seconds: number;
  post_mode: string;
  last_run_at: string | null;
  pause_reason: string | null;
  created_at: string;
};

type LinkCountRow = { list_id: string; count: number };

export default async function PromotePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let lists: ListRow[] = [];
  const linkCountById = new Map<string, number>();
  const postCountById = new Map<string, number>();
  const creditsById = new Map<string, number>();
  let accountCount = 0;

  if (user) {
    const [{ data: listData }, { data: accounts }] = await Promise.all([
      supabase
        .from("promo_list")
        .select("id, name, status, cadence_seconds, post_mode, last_run_at, pause_reason, created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("sp_account")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("status", "active"),
    ]);
    lists = (listData as ListRow[]) ?? [];
    accountCount = accounts ?? 0;

    if (lists.length > 0) {
      const listIds = lists.map((l) => l.id);

      // Fetch link counts per list
      const { data: linkCounts } = await supabase
        .from("promo_link")
        .select("list_id")
        .in("list_id", listIds);
      for (const r of (linkCounts ?? []) as Array<{ list_id: string }>) {
        linkCountById.set(r.list_id, (linkCountById.get(r.list_id) ?? 0) + 1);
      }

      // Fetch post counts + credits per list
      const { data: postStats } = await supabase
        .from("promo_post")
        .select("list_id, credits_spent")
        .in("list_id", listIds)
        .eq("status", "posted");
      for (const r of (postStats ?? []) as Array<{ list_id: string; credits_spent: number }>) {
        postCountById.set(r.list_id, (postCountById.get(r.list_id) ?? 0) + 1);
        creditsById.set(r.list_id, (creditsById.get(r.list_id) ?? 0) + (r.credits_spent ?? 0));
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Promote</h1>
        <div className="flex items-center gap-2">
          <Link href="/promote/accounts" className="btn">
            Manage accounts
          </Link>
          <Link href="/promote/new" className="btn btn-primary">
            New promote list
          </Link>
        </div>
      </div>
      <p className="mt-2 text-[var(--color-muted)]">
        Paste links. We write a fresh pitch for each and drip them across all your connected accounts.
      </p>

      {accountCount === 0 && (
        <div className="card mt-6 border-[var(--color-warn)] bg-[var(--color-warn)]/10 p-4 text-sm">
          You have no connected social accounts.{" "}
          <Link href="/promote/accounts" className="text-[var(--color-accent)] font-semibold">
            Connect an account
          </Link>{" "}
          to start promoting.
        </div>
      )}

      {lists.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-[var(--color-muted)]">
          No promote lists yet.{" "}
          <Link href="/promote/new" className="text-[var(--color-accent)]">
            Create your first list
          </Link>
          .
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {lists.map((l) => {
            const links = linkCountById.get(l.id) ?? 0;
            const posts = postCountById.get(l.id) ?? 0;
            const credits = creditsById.get(l.id) ?? 0;
            return (
              <li key={l.id} className="card p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <Link
                      href={`/promote/${l.id}`}
                      className="block truncate font-semibold hover:text-[var(--color-accent)]"
                    >
                      {l.name}
                    </Link>
                    <div className="truncate text-sm text-[var(--color-muted)]">
                      {links} link{links !== 1 ? "s" : ""} · {cadenceLabel(l.cadence_seconds)} ·{" "}
                      {l.post_mode}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`badge whitespace-nowrap ${
                        l.status === "running"
                          ? "badge-pass"
                          : l.status === "paused"
                            ? "badge-warn"
                            : ""
                      }`}
                    >
                      {l.status}
                    </span>
                    {l.pause_reason === "insufficient_credits" && (
                      <Link
                        href="/settings/billing"
                        className="text-xs text-[var(--color-fail)]"
                      >
                        low credits
                      </Link>
                    )}
                    <PromoteListActions id={l.id} status={l.status} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--color-border)] pt-3 text-sm">
                  <MiniStat label="Posts sent" value={posts.toLocaleString()} />
                  <MiniStat label="Credits spent" value={credits.toLocaleString()} />
                  <MiniStat
                    label="Last posted"
                    value={
                      l.last_run_at
                        ? new Date(l.last_run_at).toLocaleDateString()
                        : "never"
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span className="font-mono font-semibold">{value}</span>
    </span>
  );
}
