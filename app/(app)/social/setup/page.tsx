import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ConnectBlueskyForm, DisconnectButton } from "./form";

export const metadata = { title: "Social · Connect accounts" };

type AccountRow = {
  id: string;
  platform: string;
  handle: string;
  status: string;
  last_post_at: string | null;
  consecutive_failures: number;
};

export default async function SocialSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: accounts } = await supabase
    .from("sp_account")
    .select("id, platform, handle, status, last_post_at, consecutive_failures")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
          ← Dashboard
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Social accounts</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Connect your social accounts once at the account level. Each blog
          (site) you own can then choose which of these to post from.
          Phase 1 ships <strong>Bluesky</strong>; Reddit, Mastodon, LinkedIn,
          Threads, Pinterest, and Tumblr land in subsequent phases.
        </p>
      </div>

      {/* Connected accounts */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connected accounts</h2>
        {!accounts || accounts.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No accounts yet. Connect one below.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--color-border)]">
            {(accounts as AccountRow[]).map((a) => (
              <li
                key={a.id}
                className="flex items-baseline justify-between gap-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{a.handle}</span>
                    <span className="rounded bg-[var(--color-accent)]/10 px-2 py-0.5 text-xs uppercase tracking-wide text-[var(--color-accent)]">
                      {a.platform}
                    </span>
                    <span
                      className={
                        "badge " +
                        (a.status === "active"
                          ? "badge-pass"
                          : a.status === "token_expired"
                            ? "badge-warn"
                            : "badge-fail")
                      }
                    >
                      {a.status}
                    </span>
                  </div>
                  {a.last_post_at && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      Last post {new Date(a.last_post_at).toLocaleString()}
                    </p>
                  )}
                </div>
                <DisconnectButton accountId={a.id} handle={a.handle} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Connect Bluesky */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Bluesky</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Bluesky uses an <em>app password</em> — separate from your main
          account password. Generate one at{" "}
          <a
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            bsky.app/settings/app-passwords
          </a>
          . Paste the four-segment value (xxxx-xxxx-xxxx-xxxx) below. We
          immediately exchange it for a session JWT and never store the app
          password itself.
        </p>
        <ConnectBlueskyForm />
      </section>
    </div>
  );
}
