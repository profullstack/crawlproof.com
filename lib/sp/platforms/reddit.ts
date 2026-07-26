// Reddit platform module (OAuth2 web-app flow).
//
// Auth model: standard OAuth2 authorization-code flow with a single
// Crawlproof-registered app (type "web app"). The user is redirected to
// reddit.com/api/v1/authorize, they grant `identity submit` (+ optionally
// `read`), and Reddit redirects back to our callback with a `code`. We
// exchange that for {access_token, refresh_token, expires_in, scope}.
//
// Tokens go into sp_account.enc_access_token / enc_refresh_token via the
// same AES-GCM envelope as Bluesky (lib/sp/vault). The username is fetched
// from /api/v1/me and stored as `handle` + `external_id`.
//
// Posting: POST /api/submit with `kind=self`, `sr=<subreddit>`,
// `title=<title>`, `text=<body>`. Reddit requires per-post subreddit + title,
// so callers MUST pass both — the UI surfaces them when a reddit account is
// picked.
//
// User-Agent: Reddit rejects generic UAs. We send REDDIT_USER_AGENT on every
// call (see lib/env.ts) — version + contact form per Reddit's own guidance.

import { env } from "../../env";

const OAUTH_BASE = "https://www.reddit.com";
const API_BASE = "https://oauth.reddit.com";

// 'duration=permanent' grants a refresh_token alongside the access_token.
// 'identity submit' is the minimum scope set for "log in + post text posts".
//
// `read` and `privatemessages` were added for the outreach toolset
// (lib/mcp/reddit-outreach.ts), which searches threads and replies to them.
// They are still least-privilege for what the feature does — notably absent:
// `vote`, `edit`, `history`, `modposts`. Accounts connected before this
// change hold a token without the new scopes; Reddit answers those calls with
// 403 insufficient_scope and the tools tell the user to reconnect.
export const REDDIT_DEFAULT_SCOPES = [
  "identity",
  "submit",
  "read",
  "privatemessages",
] as const;

// Reddit's hard limits for self posts.
export const REDDIT_TITLE_MAX = 300;
export const REDDIT_TEXT_MAX = 40_000;

function authHeader(): string {
  // Reddit uses HTTP basic auth on the token endpoint: client_id : client_secret.
  return (
    "Basic " +
    Buffer.from(`${env.redditClientId}:${env.redditClientSecret}`).toString(
      "base64",
    )
  );
}

// Build the URL the user is sent to in order to grant consent.
// `state` is the CSRF nonce we'll verify on callback.
export function getRedditAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}): string {
  if (!env.redditClientId) {
    throw new Error("REDDIT_CLIENT_ID not configured.");
  }
  const params = new URLSearchParams({
    client_id: env.redditClientId,
    response_type: "code",
    state: input.state,
    redirect_uri: input.redirectUri,
    duration: "permanent",
    scope: (input.scopes ?? REDDIT_DEFAULT_SCOPES).join(" "),
  });
  return `${OAUTH_BASE}/api/v1/authorize?${params.toString()}`;
}

export type RedditTokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
};

// Trade `code` for tokens. Called from the OAuth callback route.
export async function exchangeRedditCode(input: {
  code: string;
  redirectUri: string;
}): Promise<RedditTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const res = await fetch(`${OAUTH_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      authorization: authHeader(),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": env.redditUserAgent,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (json.error) throw new Error(`Reddit token error: ${json.error}`);
  if (!json.access_token || !json.refresh_token || !json.expires_in) {
    throw new Error("Reddit token exchange: missing fields in response");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: json.scope ?? "",
  };
}

// Refresh an expired access_token. Reddit returns a new access_token (and
// sometimes a new refresh_token; we update both if present).
export async function refreshRedditToken(input: {
  refreshToken: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  const res = await fetch(`${OAUTH_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      authorization: authHeader(),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": env.redditUserAgent,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (json.error) throw new Error(`Reddit refresh error: ${json.error}`);
  if (!json.access_token || !json.expires_in) {
    throw new Error("Reddit refresh: missing fields in response");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? input.refreshToken,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

// Fetch the authenticated user's username + Reddit ID. Used right after
// exchangeRedditCode to populate sp_account.handle / external_id.
export async function getRedditMe(input: {
  accessToken: string;
}): Promise<{ name: string; id: string }> {
  const res = await fetch(`${API_BASE}/api/v1/me`, {
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "user-agent": env.redditUserAgent,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit /me ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { name?: string; id?: string };
  if (!json.name || !json.id) {
    throw new Error("Reddit /me: missing name/id");
  }
  return { name: json.name, id: json.id };
}

export type RedditPostResult = {
  fullname: string; // "t3_xxxxxx" — Reddit's post ID
  webUrl: string; // permalink
};

// Submit a self (text) post to a subreddit.
//
// Reddit returns a "jquery" command list rather than a clean JSON body; the
// canonical place to find the new post URL is the .url field inside the
// jquery payload at data[0][3][0]. We use api_type=json to force a normal
// JSON envelope where the URL lives at .json.data.url.
export async function createRedditSelfPost(input: {
  accessToken: string;
  subreddit: string;
  title: string;
  text: string;
}): Promise<RedditPostResult> {
  const subreddit = input.subreddit.replace(/^\/?r\//, "").replace(/^\//, "");
  const body = new URLSearchParams({
    api_type: "json",
    kind: "self",
    sr: subreddit,
    title: input.title.slice(0, REDDIT_TITLE_MAX),
    text: input.text.slice(0, REDDIT_TEXT_MAX),
    // resubmit=true lets users post the same title twice; default false.
    resubmit: "true",
    // sendreplies has no UI surface yet — default Reddit behaviour is true.
    sendreplies: "true",
  });
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": env.redditUserAgent,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Reddit submit ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    json?: {
      errors?: Array<[string, string, string?]>;
      data?: { url?: string; name?: string };
    };
  };
  const errors = json.json?.errors ?? [];
  if (errors.length > 0) {
    // Reddit error format: [code, human-message, field?]
    throw new Error(
      `Reddit submit refused: ${errors.map((e) => `${e[0]}: ${e[1]}`).join("; ")}`,
    );
  }
  const data = json.json?.data;
  if (!data?.name || !data.url) {
    throw new Error("Reddit submit: missing url/name in response");
  }
  return { fullname: data.name, webUrl: data.url };
}
