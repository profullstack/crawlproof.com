"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectBluesky,
  connectDiscord,
  connectTelegram,
  connectViaCookies,
  disconnectAccount,
} from "@/app/actions/socialPosting";
import { parseAccountHandle } from "@/lib/sp/parseHandle";

export function ConnectBlueskyForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parsedHandle = parseAccountHandle(handle, "bluesky").handle;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectBluesky({ handle, appPassword });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can post from the social dashboard.");
      setAppPassword("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Handle
        </label>
        <input
          className="input mt-1"
          type="text"
          placeholder="you.bsky.social or bsky.app/profile/you.bsky.social"
          autoComplete="off"
          required
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        {parsedHandle && parsedHandle !== handle.trim() && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            We&rsquo;ll save this as{" "}
            <code className="font-mono">{parsedHandle}</code>.
          </p>
        )}
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          App password
        </label>
        <input
          className="input mt-1 font-mono"
          type="text"
          placeholder="xxxx-xxxx-xxxx-xxxx"
          autoComplete="off"
          spellCheck={false}
          required
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          App password, NOT your main Bluesky password. Generate at{" "}
          bsky.app → Settings → App Passwords.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !handle || !appPassword}
      >
        {pending ? "Connecting…" : "Connect Bluesky"}
      </button>
    </form>
  );
}

export function ConnectDiscordForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectDiscord({ webhookUrl });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can post from the social dashboard.");
      setWebhookUrl("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Webhook URL
        </label>
        <input
          className="input mt-1 font-mono text-xs"
          type="url"
          placeholder="https://discord.com/api/webhooks/…"
          autoComplete="off"
          spellCheck={false}
          required
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          In your Discord channel: Edit Channel → Integrations → Webhooks →
          New Webhook → Copy URL. The URL is the secret; we encrypt it at
          rest.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !webhookUrl}
      >
        {pending ? "Connecting…" : "Connect Discord channel"}
      </button>
    </form>
  );
}

export function ConnectTelegramForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [botToken, setBotToken] = useState("");
  const [channel, setChannel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectTelegram({ botToken, channel });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can post from the social dashboard.");
      setBotToken("");
      setChannel("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Bot token
        </label>
        <input
          className="input mt-1 font-mono text-xs"
          type="text"
          placeholder="123456789:ABCdef…"
          autoComplete="off"
          spellCheck={false}
          required
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Get one from @BotFather on Telegram. We encrypt it at rest.
        </p>
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Channel
        </label>
        <input
          className="input mt-1"
          type="text"
          placeholder="@yourchannel or t.me/yourchannel"
          autoComplete="off"
          required
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          The @username of a public channel, its t.me link, or the numeric id
          of a private channel (starts with <code>-100</code>). Add your bot as
          an admin with “Post Messages” permission first.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !botToken || !channel}
      >
        {pending ? "Connecting…" : "Connect Telegram channel"}
      </button>
    </form>
  );
}

const IMAGE_STYLE_OPTIONS = [
  { value: "none", label: "No image" },
  { value: "editorial", label: "Editorial photo" },
  { value: "infographic", label: "Infographic" },
  { value: "quote_card", label: "Quote card" },
  { value: "diagram", label: "Diagram" },
  { value: "screenshot", label: "UI screenshot" },
  { value: "rotate", label: "Rotate through all" },
] as const;

const PLATFORM_LABELS: Record<string, string> = {
  reddit: "Reddit",
  facebook_page: "Facebook Page",
  threads: "Threads",
  instagram: "Instagram",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  mastodon: "Mastodon",
};

// Both forms of what people actually paste, so the field reads as
// "either of these is fine" rather than "type it by hand".
const HANDLE_PLACEHOLDERS: Record<string, string> = {
  reddit: "yourusername or reddit.com/user/yourusername",
  facebook_page: "MyPage, 123456789, or facebook.com/MyPage",
  threads: "yourusername or threads.net/@yourusername",
  instagram: "yourusername or instagram.com/yourusername",
  x: "yourusername or x.com/yourusername",
  linkedin: "yourname or linkedin.com/in/yourname",
  mastodon: "yourusername or mastodon.social/@yourusername",
};

const PLATFORM_HINTS: Record<string, string> = {
  reddit: "Log in to reddit.com, then export cookies with the Cookie-Editor extension.",
  facebook_page:
    "Log in to facebook.com as the Page admin, then export cookies with Cookie-Editor.",
  threads: "Log in to threads.net, then export cookies with Cookie-Editor.",
  instagram:
    "Log in to instagram.com, then export cookies with Cookie-Editor. An AI-generated image will be attached to every post (Instagram requires an image).",
  x: "Log in to x.com, then export cookies with Cookie-Editor. No paid API needed.",
  linkedin: "Log in to linkedin.com, then export cookies with Cookie-Editor.",
  mastodon:
    "Log in to your Mastodon instance, then export cookies with Cookie-Editor. Enter your instance URL below.",
};

export function ConnectViaCookiesForm({
  platform,
}: {
  platform: "reddit" | "facebook_page" | "threads" | "instagram" | "x" | "linkedin" | "mastodon";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [handle, setHandle] = useState("");
  const [cookiesJson, setCookiesJson] = useState("");
  const [imageStyle, setImageStyle] = useState(
    platform === "instagram" ? "editorial" : "none",
  );
  const [instanceUrl, setInstanceUrl] = useState("mastodon.social");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Same parse the server will do, so what we show is what gets stored.
  const parsed = parseAccountHandle(handle, platform);
  const parsedHandle = parsed.handle;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    start(async () => {
      const r = await connectViaCookies({
        platform,
        cookiesJson,
        handle,
        imageStyle,
        ...(platform === "mastodon" ? { instanceUrl } : {}),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setNotice("Connected. You can now post to this account.");
      setCookiesJson("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <p className="text-xs text-[var(--color-muted)]">{PLATFORM_HINTS[platform]}</p>
      {platform === "mastodon" && (
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Instance URL
          </label>
          <input
            className="input mt-1"
            type="text"
            placeholder="mastodon.social"
            autoComplete="off"
            required
            value={instanceUrl}
            onChange={(e) => setInstanceUrl(e.target.value)}
          />
          {parsed.host && parsed.host !== instanceUrl.trim() && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              The URL below names{" "}
              <code className="font-mono">{parsed.host}</code> — we&rsquo;ll use
              that instead.
            </p>
          )}
        </div>
      )}
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          {platform === "facebook_page" ? "Page name, ID or URL" : "Username or profile URL"}
        </label>
        <input
          className="input mt-1"
          type="text"
          placeholder={HANDLE_PLACEHOLDERS[platform]}
          autoComplete="off"
          required
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {parsedHandle && parsedHandle !== handle.trim() ? (
            <>
              We&rsquo;ll save this as{" "}
              <code className="font-mono">{parsedHandle}</code>.
            </>
          ) : (
            <>Paste the profile URL and we&rsquo;ll pull the name out of it.</>
          )}
        </p>
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Cookie JSON{" "}
          <span className="normal-case font-normal">
            (from{" "}
            <a
              href="https://cookie-editor.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Cookie-Editor
            </a>
            {" "}→ Export → Export as JSON)
          </span>
        </label>
        <textarea
          className="input mt-1 font-mono text-xs"
          rows={5}
          placeholder='[{"name":"session_id","value":"...","domain":".reddit.com",...}]'
          spellCheck={false}
          required
          value={cookiesJson}
          onChange={(e) => setCookiesJson(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Image style (AI-generated image per post)
        </label>
        <select
          className="input mt-1"
          value={imageStyle}
          onChange={(e) => setImageStyle(e.target.value)}
        >
          {IMAGE_STYLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} disabled={platform === "instagram" && o.value === "none"}>
              {o.label}
            </option>
          ))}
        </select>
        {platform === "instagram" && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Instagram requires an image — "No image" is disabled.
          </p>
        )}
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {notice && <p className="text-sm text-[var(--color-pass)]">{notice}</p>}
      <button
        type="submit"
        className="btn btn-primary"
        disabled={pending || !handle || !cookiesJson}
      >
        {pending ? "Saving…" : `Connect ${PLATFORM_LABELS[platform]}`}
      </button>
    </form>
  );
}

export function DisconnectButton({
  accountId,
  handle,
}: {
  accountId: string;
  handle: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        className="text-xs text-[var(--color-fail)] hover:underline"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Disconnect ${handle}? Queued posts will be deleted.`))
            return;
          setError(null);
          start(async () => {
            // An account with a long posting history takes a while to
            // clear, so this can be a slow one — but it must never fail
            // in silence the way it used to.
            const r = await disconnectAccount(accountId).catch(
              (err: unknown) => ({
                ok: false as const,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
            if (!r.ok) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      {error && (
        <p className="mt-1 max-w-[16rem] text-xs text-[var(--color-fail)]">
          {error}
        </p>
      )}
    </div>
  );
}
