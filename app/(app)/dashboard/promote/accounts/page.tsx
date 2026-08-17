import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ConnectBlueskyForm,
  ConnectDiscordForm,
  ConnectTelegramForm,
  ConnectViaCookiesForm,
  DisconnectButton,
} from "@/app/(app)/dashboard/projects/[id]/social/setup/form";

export const metadata = { title: "Promote · Accounts" };

type AccountRow = {
  id: string;
  platform: string;
  handle: string;
  status: string;
  last_post_at: string | null;
  consecutive_failures: number;
  session_refreshed_at: string | null;
};

const PLATFORM_LOGIN_URLS: Record<string, string | undefined> = {
  reddit: "https://www.reddit.com/login",
  facebook_page: "https://www.facebook.com/login",
  threads: "https://www.threads.net/login",
  instagram: "https://www.instagram.com/accounts/login/",
  x: "https://x.com/login",
  linkedin: "https://www.linkedin.com/login",
};

export default async function PromoteAccountsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: accounts } = await supabase
    .from("sp_account")
    .select(
      "id, platform, handle, status, last_post_at, consecutive_failures, session_refreshed_at",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <Link
          href="/dashboard/promote"
          className="text-sm text-[var(--color-muted)]"
        >
          &larr; Promote
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Social accounts</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Connect your social accounts here. These are shared across Promote
          and per-project Social features — connect once, use everywhere.
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
                  {a.status === "active" && a.session_refreshed_at && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      Session kept alive {new Date(a.session_refreshed_at).toLocaleString()}
                    </p>
                  )}
                  {a.status !== "active" && PLATFORM_LOGIN_URLS[a.platform] && (
                    <p className="mt-1 text-xs text-[var(--color-warn)]">
                      Session expired.{" "}
                      <a
                        href={PLATFORM_LOGIN_URLS[a.platform]!}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        Log in to {a.platform}
                      </a>{" "}
                      and re-export cookies below.
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
          Generate an app password at{" "}
          <a
            href="https://bsky.app/settings/app-passwords"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            bsky.app/settings/app-passwords
          </a>{" "}
          and paste it below.
        </p>
        <ConnectBlueskyForm />
      </section>

      {/* Connect Reddit */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Reddit</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from reddit.com using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="reddit" />
      </section>

      {/* Connect Threads */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Threads</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from threads.net using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="threads" />
      </section>

      {/* Connect Facebook Page */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Facebook Page</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from facebook.com using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="facebook_page" />
      </section>

      {/* Connect Instagram */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Instagram</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from instagram.com using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="instagram" />
      </section>

      {/* Connect X */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect X (Twitter)</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from x.com using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="x" />
      </section>

      {/* Connect LinkedIn */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect LinkedIn</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from linkedin.com using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="linkedin" />
      </section>

      {/* Connect Mastodon */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Mastodon</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Export cookies from your Mastodon instance using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          .
        </p>
        <ConnectViaCookiesForm platform="mastodon" />
      </section>

      {/* Connect Discord */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Discord channel</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          In Discord: Edit Channel → Integrations → Webhooks → New Webhook → Copy URL.
        </p>
        <ConnectDiscordForm />
      </section>

      {/* Connect Telegram */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Telegram channel</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Create a bot via{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">
            @BotFather
          </a>{" "}
          and add it as a channel admin.
        </p>
        <ConnectTelegramForm />
      </section>
    </div>
  );
}
