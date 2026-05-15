import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ConnectBlueskyForm,
  ConnectDiscordForm,
  ConnectTelegramForm,
  DisconnectButton,
} from "./form";

export const metadata = { title: "Social · Connect accounts" };

type SetupSearchParams = Promise<{
  connected?: string;
  error?: string;
}>;

type AccountRow = {
  id: string;
  platform: string;
  handle: string;
  status: string;
  last_post_at: string | null;
  consecutive_failures: number;
};

export default async function SocialSetupPage({
  searchParams,
}: {
  searchParams: SetupSearchParams;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const oauthError = sp.error ?? null;
  const connected = sp.connected ?? null;

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
          Phase 1 supports <strong>Bluesky</strong>, <strong>Reddit</strong>,{" "}
          <strong>Mastodon</strong>, <strong>LinkedIn</strong>,{" "}
          <strong>Discord</strong>, and <strong>Telegram</strong>. Threads,
          Pinterest, X, Facebook, Instagram, TikTok, and YouTube land in
          subsequent phases (most are blocked on per-platform app review or
          paid API access).
        </p>
      </div>

      {connected && (
        <p className="rounded border border-[var(--color-pass)]/40 bg-[var(--color-pass)]/10 px-3 py-2 text-sm text-[var(--color-pass)]">
          Connected your {connected} account.
        </p>
      )}
      {oauthError && (
        <p className="rounded border border-[var(--color-fail)]/40 bg-[var(--color-fail)]/10 px-3 py-2 text-sm text-[var(--color-fail)]">
          {oauthError}
        </p>
      )}

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

      {/* Connect Reddit */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Reddit</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Reddit uses standard OAuth. Click below to redirect to Reddit, grant
          permission, and come back — we ask only for the <code>identity</code>{" "}
          and <code>submit</code> scopes (read your username + post on your
          behalf). Refresh tokens are stored encrypted.
        </p>
        <a href="/api/sp/oauth/reddit/start" className="btn btn-primary mt-4">
          Connect Reddit
        </a>
      </section>

      {/* Connect LinkedIn */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect LinkedIn</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          LinkedIn uses standard OAuth. We request <code>openid</code>,{" "}
          <code>profile</code>, <code>email</code>, and{" "}
          <code>w_member_social</code> (post as you). The access token
          lasts 60 days — you'll be prompted to reconnect after that.
        </p>
        <a
          href="/api/sp/oauth/linkedin/start"
          className="btn btn-primary mt-4"
        >
          Connect LinkedIn
        </a>
      </section>

      {/* Connect Mastodon */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Mastodon</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Mastodon is federated — every instance is its own OAuth provider.
          Enter the URL of your instance (e.g. <code>mastodon.social</code> or{" "}
          <code>fosstodon.org</code>). We register a Crawlproof app there
          automatically the first time, then redirect you to grant{" "}
          <code>read</code> + <code>write:statuses</code> permission.
        </p>
        <form
          method="POST"
          action="/api/sp/oauth/mastodon/start"
          className="mt-4 flex flex-wrap gap-2"
        >
          <input
            className="input min-w-[16rem] flex-1"
            type="text"
            name="instance_url"
            placeholder="mastodon.social"
            autoComplete="off"
            required
          />
          <button type="submit" className="btn btn-primary">
            Connect Mastodon
          </button>
        </form>
      </section>

      {/* Connect Discord */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Discord channel</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          One webhook per channel. In Discord: <em>Edit Channel →
          Integrations → Webhooks → New Webhook → Copy URL</em>, then paste
          below. No bot to manage, no OAuth — the webhook URL itself
          authorises posting and is encrypted at rest.
        </p>
        <ConnectDiscordForm />
      </section>

      {/* Connect Telegram */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Telegram channel</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Create a bot via <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >@BotFather</a> to get a token. In your channel, <em>Manage
          channel → Administrators → Add Administrator</em>, search for your
          bot, and grant <em>Post Messages</em>. Then paste the token + the
          channel @username below.
        </p>
        <ConnectTelegramForm />
      </section>
    </div>
  );
}
