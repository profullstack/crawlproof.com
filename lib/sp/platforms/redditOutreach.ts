// Reddit API calls used by the outreach toolset: search, subreddit rules,
// comment replies, and private messages.
//
// Auth is the same OAuth2 connection the Promote feature already uses
// (sp_account, platform='reddit', AES-GCM tokens in lib/sp/vault) — the user
// grants consent once at /api/sp/oauth/reddit. There is no cookie replay and
// no browser extension here: Reddit's official API can search, comment and
// compose PMs, so the only reason to drive a logged-in browser session
// instead is to exceed the limits the API enforces, which is exactly the
// behaviour that gets accounts banned.
//
// Scopes required: read (search), submit (comment), privatemessages
// (compose). Connections made before those were requested get a 403 from
// Reddit; RedditScopeError translates that into "reconnect your account".

import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret, encryptSecret } from "@/lib/sp/vault";
import { env } from "@/lib/env";
import { refreshRedditToken } from "./reddit";
import type { RedditThread } from "@/lib/outreach/reddit";

const API_BASE = "https://oauth.reddit.com";

export class RedditScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedditScopeError";
  }
}

export type RedditConnection = {
  accountId: string;
  username: string;
  accessToken: string;
};

type AccountRow = {
  id: string;
  handle: string;
  status: string;
  enc_access_token: string | null;
  enc_refresh_token: string | null;
  token_expires_at: string | null;
};

/**
 * Resolve the caller's connected Reddit account to a usable access token,
 * refreshing it first when it is about to expire. Mirrors the refresh block
 * in lib/sp/post.ts; kept separate because outreach reads (search) must work
 * even when the account is not in a postable state.
 */
export async function redditConnection(userId: string): Promise<RedditConnection> {
  const sb = serviceClient();
  const { data } = await sb
    .from("sp_account")
    .select("id, handle, status, enc_access_token, enc_refresh_token, token_expires_at")
    .eq("user_id", userId)
    .eq("platform", "reddit")
    .order("created_at", { ascending: false })
    .limit(1);
  const account = (data as AccountRow[] | null)?.[0];
  if (!account) {
    throw new Error(
      "No Reddit account connected. Connect one at /settings/social (Reddit → Connect) and re-run.",
    );
  }
  if (!account.enc_access_token) {
    throw new Error("The connected Reddit account has no stored token — reconnect it.");
  }

  let accessToken = decryptSecret(account.enc_access_token);
  const nearExpiry =
    !!account.token_expires_at &&
    !!account.enc_refresh_token &&
    new Date(account.token_expires_at).getTime() - Date.now() < 60_000;

  if (nearExpiry && account.enc_refresh_token) {
    try {
      const fresh = await refreshRedditToken({
        refreshToken: decryptSecret(account.enc_refresh_token),
      });
      accessToken = fresh.accessToken;
      await sb
        .from("sp_account")
        .update({
          enc_access_token: encryptSecret(fresh.accessToken),
          enc_refresh_token: fresh.refreshToken ? encryptSecret(fresh.refreshToken) : null,
          token_expires_at: fresh.expiresAt.toISOString(),
        })
        .eq("id", account.id);
    } catch (err) {
      await sb.from("sp_account").update({ status: "token_expired" }).eq("id", account.id);
      throw new Error(
        `Reddit token refresh failed: ${err instanceof Error ? err.message : "unknown"}. Reconnect the account.`,
      );
    }
  }

  return { accountId: account.id, username: account.handle, accessToken };
}

async function redditFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: URLSearchParams },
): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": env.redditUserAgent,
      ...(init?.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init?.body,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    if (/insufficient_scope|scope/i.test(text)) {
      throw new RedditScopeError(
        "Reddit refused the call for lack of scope. This account was connected before outreach needed " +
          "`read` and `privatemessages` — disconnect and reconnect it at /settings/social to re-grant.",
      );
    }
    throw new Error(`Reddit 403: ${text.slice(0, 200)}`);
  }
  if (res.status === 429) {
    throw new Error("Reddit rate-limited the request (429). Wait a few minutes before retrying.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

type ListingChild = {
  kind: string;
  data: Record<string, unknown>;
};

function toThread(child: ListingChild): RedditThread | null {
  const d = child.data;
  const id = String(d.name ?? "");
  if (!id || child.kind !== "t3") return null;
  return {
    id,
    subreddit: String(d.subreddit ?? ""),
    title: String(d.title ?? ""),
    selftext: String(d.selftext ?? ""),
    author: String(d.author ?? ""),
    permalink: `https://www.reddit.com${String(d.permalink ?? "")}`,
    createdUtc: Number(d.created_utc ?? 0),
    numComments: Number(d.num_comments ?? 0),
    score: Number(d.score ?? 0),
    over18: Boolean(d.over_18),
    locked: Boolean(d.locked),
    archived: Boolean(d.archived),
  };
}

/**
 * Search threads. `sort=new` rather than `relevance` on purpose — outreach
 * wants the question asked an hour ago, not the highest-ranked thread from
 * 2019, and Reddit's relevance sort is heavily weighted toward the latter.
 */
export async function searchThreads(input: {
  accessToken: string;
  query: string;
  subreddit?: string | null;
  limit?: number;
  timeframe?: "hour" | "day" | "week" | "month";
}): Promise<RedditThread[]> {
  const params = new URLSearchParams({
    q: input.query,
    sort: "new",
    t: input.timeframe ?? "week",
    limit: String(Math.min(input.limit ?? 25, 100)),
    type: "link",
    raw_json: "1",
  });
  if (input.subreddit) params.set("restrict_sr", "1");
  const path = input.subreddit
    ? `/r/${encodeURIComponent(input.subreddit)}/search?${params}`
    : `/search?${params}`;

  const json = (await redditFetch(input.accessToken, path)) as {
    data?: { children?: ListingChild[] };
  };
  return (json.data?.children ?? []).map(toThread).filter((t): t is RedditThread => t !== null);
}

/** Look one thread up by fullname (t3_…). Used before drafting or replying. */
export async function getThread(input: {
  accessToken: string;
  fullname: string;
}): Promise<RedditThread | null> {
  const json = (await redditFetch(
    input.accessToken,
    `/api/info?id=${encodeURIComponent(input.fullname)}&raw_json=1`,
  )) as { data?: { children?: ListingChild[] } };
  const child = json.data?.children?.[0];
  return child ? toThread(child) : null;
}

export type SubredditRule = { shortName?: string; description?: string };

export async function subredditRules(input: {
  accessToken: string;
  subreddit: string;
}): Promise<SubredditRule[]> {
  const json = (await redditFetch(
    input.accessToken,
    `/r/${encodeURIComponent(input.subreddit)}/about/rules?raw_json=1`,
  )) as { rules?: Array<{ short_name?: string; description?: string }> };
  return (json.rules ?? []).map((r) => ({
    shortName: r.short_name,
    description: r.description,
  }));
}

export type RedditReplyResult = { fullname: string; permalink: string | null };

/** Reply to a post or comment. thingId is a fullname: t3_… or t1_…. */
export async function postRedditComment(input: {
  accessToken: string;
  thingId: string;
  text: string;
}): Promise<RedditReplyResult> {
  const body = new URLSearchParams({
    api_type: "json",
    thing_id: input.thingId,
    text: input.text,
  });
  const json = (await redditFetch(input.accessToken, "/api/comment", {
    method: "POST",
    body,
  })) as {
    json?: {
      errors?: Array<[string, string, string?]>;
      data?: { things?: Array<{ data?: { name?: string; permalink?: string } }> };
    };
  };
  const errors = json.json?.errors ?? [];
  if (errors.length) {
    throw new Error(`Reddit refused the comment: ${errors.map((e) => `${e[0]}: ${e[1]}`).join("; ")}`);
  }
  const thing = json.json?.data?.things?.[0]?.data;
  return {
    fullname: thing?.name ?? "",
    permalink: thing?.permalink ? `https://www.reddit.com${thing.permalink}` : null,
  };
}

/** Send a private message. `to` is a username without the u/ prefix. */
export async function sendRedditMessage(input: {
  accessToken: string;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const body = new URLSearchParams({
    api_type: "json",
    to: input.to.replace(/^\/?u\//, ""),
    subject: input.subject.slice(0, 100),
    text: input.text,
  });
  const json = (await redditFetch(input.accessToken, "/api/compose", {
    method: "POST",
    body,
  })) as { json?: { errors?: Array<[string, string, string?]> } };
  const errors = json.json?.errors ?? [];
  if (errors.length) {
    throw new Error(`Reddit refused the message: ${errors.map((e) => `${e[0]}: ${e[1]}`).join("; ")}`);
  }
}
