import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ConnectBlueskyForm,
  ConnectDiscordForm,
  ConnectTelegramForm,
  ConnectViaCookiesForm,
  DisconnectButton,
} from "./form";
import { AppPasswordReveal } from "./app-password-reveal";

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
  enc_app_password: string | null;
};

export default async function SocialSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SetupSearchParams;
}) {
  const { id: projectId } = await params;
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
    .select(
      "id, platform, handle, status, last_post_at, consecutive_failures, enc_app_password",
    )
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}/social`}
          className="text-sm text-[var(--color-muted)]"
        >
          ← Social
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Social accounts</h1>
        <Link
          href={`/projects/${projectId}/social/api-tokens`}
          className="float-right text-sm text-[var(--color-muted)] hover:underline"
        >
          API tokens →
        </Link>
        <p className="mt-2 text-[var(--color-muted)]">
          Connect your social accounts once at the account level. Each blog
          (site) you own can then choose which of these to post from.
          Phase 1 supports <strong>Bluesky</strong>, <strong>Reddit</strong>,{" "}
          <strong>Mastodon</strong>, <strong>LinkedIn</strong>,{" "}
          <strong>X</strong>, <strong>Facebook Pages</strong>,{" "}
          <strong>Discord</strong>, and <strong>Telegram</strong>. X needs
          paid API access; Facebook Pages work for Pages you admin in dev
          mode (Meta review required for customer Pages). Instagram,
          Threads, TikTok, Pinterest, and YouTube ship next.
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
                  {a.platform === "bluesky" && a.enc_app_password && (
                    <AppPasswordReveal accountId={a.id} />
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
          Uses your browser session cookies — no API approval needed. Export
          your cookies from reddit.com using the{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>{" "}
          extension, then paste below. Cookies typically last 30–90 days.
        </p>
        <ConnectViaCookiesForm platform="reddit" />
      </section>

      {/* Connect Threads */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Threads</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Uses your browser session cookies — no Meta app review needed. Export
          your cookies from threads.net using{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          , then paste below.
        </p>
        <ConnectViaCookiesForm platform="threads" />
      </section>

      {/* Connect Facebook Page */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Facebook Page</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Uses your browser session cookies — no Meta app review needed. Log in
          to facebook.com as your Page admin, export cookies via{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          , and paste below.
        </p>
        <ConnectViaCookiesForm platform="facebook_page" />
      </section>

      {/* Connect Instagram */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Instagram</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Uses your browser session cookies — no Meta app review needed. Log in
          to instagram.com, export cookies via{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          , and paste below. An AI-generated image is attached to every post
          (Instagram requires an image).
        </p>
        <ConnectViaCookiesForm platform="instagram" />
      </section>

      {/* Connect X */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect X (Twitter)</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Uses your browser session cookies — no paid API needed. Log in to{" "}
          x.com, export cookies via{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          , and paste below.
        </p>
        <ConnectViaCookiesForm platform="x" />
      </section>

      {/* Connect LinkedIn */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect LinkedIn</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Uses your browser session cookies. Log in to linkedin.com, export
          cookies via{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          , and paste below.
        </p>
        <ConnectViaCookiesForm platform="linkedin" />
      </section>

      {/* Connect Mastodon */}
      <section className="card p-5">
        <h2 className="text-lg font-semibold">Connect Mastodon</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Uses your browser session cookies. Log in to your Mastodon instance,
          export cookies via{" "}
          <a href="https://cookie-editor.com" target="_blank" rel="noreferrer" className="underline">
            Cookie-Editor
          </a>
          , and paste below.
        </p>
        <ConnectViaCookiesForm platform="mastodon" />
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
