// Threads platform module — Meta for Developers Threads Graph API.
//
// Auth model: OAuth2 on the threads.net authorize host, but every API
// call goes against graph.threads.net. Threads is a separate Meta
// product from Facebook/Instagram — it has its own client id/secret
// (configured under the same app, via "Threads API" product) and its
// own scope set (NOT the Graph API scopes).
//
// We reuse META_APP_ID / META_APP_SECRET since one Meta app can own
// Facebook + Instagram + Threads products; the client id IS the same
// numeric app id.
//
// Scopes:
//   - `threads_basic` — read profile.
//   - `threads_content_publish` — post threads.
//
// Both need Meta app review for use beyond the developer's own
// account; works in dev mode for the app's owner/testers immediately.
//
// Posting: two-step like Instagram Graph. First POST /me/threads to
// create a "media container" (the post draft), then POST
// /me/threads_publish to publish it. The container is the post body
// (text + optional media); publish returns the post id.

import { env } from "../../env";

const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const LONG_LIVED_TOKEN_URL = "https://graph.threads.net/access_token";
const API_BASE = "https://graph.threads.net/v1.0";

export const THREADS_DEFAULT_SCOPES = [
  "threads_basic",
  "threads_content_publish",
] as const;

// Threads' hard cap is 500 chars (matching the public-product limit).
export const THREADS_MAX_CHARS = 500;

export function getThreadsAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}): string {
  if (!env.metaAppId) throw new Error("META_APP_ID not configured.");
  const params = new URLSearchParams({
    client_id: env.metaAppId,
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: "code",
    scope: (input.scopes ?? THREADS_DEFAULT_SCOPES).join(","),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type ThreadsToken = {
  accessToken: string;
  userId: string; // Threads user id, returned alongside the short-lived token
};

// Threads exchange returns a short-lived token + the user_id. We
// immediately upgrade to a long-lived token (~60 days) via /access_token.
export async function exchangeThreadsCode(input: {
  code: string;
  redirectUri: string;
}): Promise<ThreadsToken> {
  const body = new URLSearchParams({
    client_id: env.metaAppId,
    client_secret: env.metaAppSecret,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Threads token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    user_id?: number | string;
  };
  if (!json.access_token || json.user_id === undefined) {
    throw new Error("Threads token exchange: missing fields");
  }
  return {
    accessToken: json.access_token,
    userId: String(json.user_id),
  };
}

export type ThreadsLongLivedToken = {
  accessToken: string;
  expiresAt: Date;
};

export async function exchangeForLongLivedThreadsToken(input: {
  shortLivedToken: string;
}): Promise<ThreadsLongLivedToken> {
  const params = new URLSearchParams({
    grant_type: "th_exchange_token",
    client_secret: env.metaAppSecret,
    access_token: input.shortLivedToken,
  });
  const res = await fetch(`${LONG_LIVED_TOKEN_URL}?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Threads long-lived ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.expires_in) {
    throw new Error("Threads long-lived: missing fields");
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}

export type ThreadsMe = {
  id: string;
  username: string;
};

export async function getThreadsMe(input: {
  accessToken: string;
}): Promise<ThreadsMe> {
  const url = new URL(`${API_BASE}/me`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", input.accessToken);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Threads /me ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id?: string; username?: string };
  if (!json.id || !json.username) {
    throw new Error("Threads /me: missing fields");
  }
  return { id: json.id, username: json.username };
}

export type ThreadsPostResult = {
  threadId: string;
  webUrl: string;
};

export async function createThreadsPost(input: {
  accessToken: string;
  userId: string;
  username: string;
  text: string;
}): Promise<ThreadsPostResult> {
  const text = input.text.slice(0, THREADS_MAX_CHARS);

  // Step 1: create the media container (the draft post body).
  const containerBody = new URLSearchParams({
    media_type: "TEXT",
    text,
    access_token: input.accessToken,
  });
  const containerRes = await fetch(`${API_BASE}/${input.userId}/threads`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: containerBody,
  });
  if (!containerRes.ok) {
    const body = await containerRes.text().catch(() => "");
    throw new Error(
      `Threads container ${containerRes.status}: ${body.slice(0, 200)}`,
    );
  }
  const containerJson = (await containerRes.json()) as { id?: string };
  if (!containerJson.id) {
    throw new Error("Threads container: missing id");
  }

  // Step 2: publish the container.
  const publishBody = new URLSearchParams({
    creation_id: containerJson.id,
    access_token: input.accessToken,
  });
  const publishRes = await fetch(
    `${API_BASE}/${input.userId}/threads_publish`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: publishBody,
    },
  );
  if (!publishRes.ok) {
    const body = await publishRes.text().catch(() => "");
    throw new Error(`Threads publish ${publishRes.status}: ${body.slice(0, 200)}`);
  }
  const publishJson = (await publishRes.json()) as { id?: string };
  if (!publishJson.id) throw new Error("Threads publish: missing id");

  return {
    threadId: publishJson.id,
    webUrl: `https://www.threads.net/@${input.username}/post/${publishJson.id}`,
  };
}
