import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PostNowForm } from "./post-now";
import { FeedSettingsForm } from "./feed-settings";
import { SocialAutoRefresh } from "./auto-refresh";
import { SocialProfileForm, type SocialProfile } from "./social-profile";
import { Countdown } from "../autoblog/countdown";
import { nextPlatformReleases } from "@/lib/sp/feedAutopost";

// Must match FEED_POLL_EVERY_MS in lib/sp/feedAutopost.ts — the worker
// re-checks a feed once its last_checked_at is older than this.
const FEED_POLL_EVERY_MS = 15 * 60 * 1000;

export const metadata = { title: "Social" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Posts are stored as a single rendered_text blob. Feed autoposts come in as
// "title\nurl"; manual posts can be anything. Pull the first URL out so we
// can show it as a real link, and use whatever remains as the title.
function splitPostText(text: string): { title: string | null; url: string | null } {
  if (!text) return { title: null, url: null };
  const match = text.match(/https?:\/\/[^\s<>"'`]+/);
  if (!match) return { title: text.trim() || null, url: null };
  const url = match[0].replace(/[).,!?;:]+$/, "");
  const title = text.replace(match[0], "").trim();
  return { title: title || null, url };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
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
    { data: socialProfileRow },
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
      .limit(50),
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
    supabase
      .from("sp_project_config")
      .select(
        "brand_voice, tone, default_hashtags, image_cadence, image_style, custom_instructions",
      )
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);
  const socialProfile = (socialProfileRow ?? null) as SocialProfile | null;

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

  // Only auto-refresh while something is actively moving. Idle tabs
  // shouldn't be hitting the DB every 15s.
  const inFlightPosts = (posts ?? []).filter(
    (p: any) => p.status === "queued" || p.status === "publishing",
  );
  const hasInFlightPost = inFlightPosts.length > 0;
  const feedChecking =
    (feedConfig as { status?: string } | null)?.status === "checking";

  // Compute the next worker check ETA. Worker sweeps every 60s and picks
  // up any config with last_checked_at older than FEED_POLL_EVERY_MS.
  const fc = feedConfig as
    | { enabled: boolean; last_checked_at: string | null }
    | null;
  const autopostAccounts = autopostAccountIds
    .map((id) => accountById.get(id))
    .filter(Boolean) as Array<{ platform: string; handle: string }>;
  const platformsList = autopostAccounts.length
    ? autopostAccounts.map((a) => `${a.platform} ${a.handle}`).join(", ")
    : null;
  const boundPlatforms = [...new Set(autopostAccounts.map((a) => a.platform))];
  const throttleReleases = await nextPlatformReleases(
    supabase,
    user.id,
    boundPlatforms,
  );
  let nextCheckIso: string | null = null;
  let scheduleState: "off" | "no-targets" | "due" | "checking" | "scheduled" =
    "off";
  if (!fc?.enabled) {
    scheduleState = "off";
  } else if (autopostAccounts.length === 0) {
    scheduleState = "no-targets";
  } else if (feedChecking) {
    scheduleState = "checking";
  } else if (!fc.last_checked_at) {
    scheduleState = "due";
  } else {
    const nextMs = new Date(fc.last_checked_at).getTime() + FEED_POLL_EVERY_MS;
    if (nextMs <= Date.now()) {
      scheduleState = "due";
    } else {
      scheduleState = "scheduled";
      nextCheckIso = new Date(nextMs).toISOString();
    }
  }

  // Auto-refresh while something is actively moving OR the next check
  // is due (worker should pick it up within 60s — surface the change
  // without a manual reload).
  const isLive =
    hasInFlightPost || scheduleState === "checking" || scheduleState === "due";

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
        <div>
          <h2 className="text-lg font-semibold">Brand profile</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Drives the per-platform LLM renderer. Every autopost is
            tailored to the platform's voice on top of these settings,
            so Bluesky doesn't sound like LinkedIn.
          </p>
        </div>
        <div className="mt-4">
          <SocialProfileForm projectId={projectId} profile={socialProfile} />
        </div>
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Schedule</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Fully automated. The worker re-checks the feed every 15
              minutes and posts any new URLs to every autopost-enabled
              account.
            </p>
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Next feed check
            </dt>
            <dd className="mt-1 font-medium">
              {scheduleState === "off" && (
                <span className="text-[var(--color-muted)]">
                  Feed autopost is OFF — enable it below
                </span>
              )}
              {scheduleState === "no-targets" && (
                <span className="text-[var(--color-warn)]">
                  No autopost accounts selected — nothing to post to
                </span>
              )}
              {scheduleState === "checking" && (
                <span className="text-[var(--color-pass)]">
                  Checking now…
                </span>
              )}
              {scheduleState === "due" && (
                <span className="text-[var(--color-pass)]">
                  Due — should pick up within 60s
                </span>
              )}
              {scheduleState === "scheduled" && (
                <>
                  <Countdown targetIso={nextCheckIso} />{" "}
                  <span className="text-xs font-normal text-[var(--color-muted)]">
                    ({fmtDate(nextCheckIso)})
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Posting to
            </dt>
            <dd className="mt-1 font-medium">
              {platformsList ? (
                <span>{platformsList}</span>
              ) : (
                <span className="text-[var(--color-muted)]">
                  No platforms — pick at least one below
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Last check
            </dt>
            <dd className="mt-1 font-medium">
              {fc?.last_checked_at ? fmtDate(fc.last_checked_at) : "Never"}
              {fc && "last_error" in fc && (fc as any).last_error && (
                <span className="ml-2 text-xs font-normal text-[var(--color-fail)]">
                  {(fc as any).last_error}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              In flight
            </dt>
            <dd className="mt-1 font-medium">
              {hasInFlightPost
                ? `${inFlightPosts.length} post${inFlightPosts.length === 1 ? "" : "s"} queued or publishing`
                : "Nothing queued"}
            </dd>
          </div>
        </dl>
        {boundPlatforms.length > 0 && (
          <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Per-platform throttle · 1 post / 4h
            </div>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {boundPlatforms.map((p) => {
                const releaseIso = throttleReleases[p] ?? null;
                return (
                  <li key={p} className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{p}</span>
                    {releaseIso ? (
                      <span className="text-xs text-[var(--color-warn)]">
                        next post <Countdown targetIso={releaseIso} />
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-pass)]">
                        ready
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Feed autopost settings</h2>
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
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Post history
          </h2>
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            {isLive ? "Live · refreshes every 15s" : "Idle · reload to update"}
          </span>
        </div>
        <SocialAutoRefresh active={isLive} />
        {(posts ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            No posts yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
            {posts!.map((p: any) => {
              const a = accountById.get(p.account_id);
              const { title, url } = splitPostText(p.rendered_text ?? "");
              const headline = title ?? (url ? hostOf(url) : "(empty post)");
              return (
                <li key={p.id} className="px-3 py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="line-clamp-2 flex-1 font-medium hover:underline"
                        title={url}
                      >
                        {headline}
                      </a>
                    ) : (
                      <span className="line-clamp-2 flex-1 font-medium">
                        {headline}
                      </span>
                    )}
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
                  {url && title && (
                    <div className="mt-1 text-xs text-[var(--color-muted)]">
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {hostOf(url)}
                      </a>
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs text-[var(--color-muted)]">
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
                          view on {a?.platform ?? "platform"}
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
