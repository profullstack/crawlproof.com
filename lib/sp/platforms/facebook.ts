// Facebook Page platform module — Graph API.
//
// Auth model: standard OAuth2 against the Meta Graph endpoint. The
// user authorizes our app to act on their Facebook account, then we
// call /me/accounts to enumerate the Pages they manage. For each Page
// the response includes a long-lived Page access token; that's the
// token we actually post with (NOT the user access token). Each Page
// becomes its own sp_account row.
//
// Scopes (all require Meta app review for use beyond the developer's
// own Pages):
//   - `pages_show_list` — list the Pages the user manages.
//   - `pages_manage_posts` — POST to /{page-id}/feed.
//   - `pages_read_engagement` — required alongside pages_manage_posts.
//   - `public_profile` — implicit, no review.
//
// Dev mode posting: works on Pages the user (= app developer) admins,
// without review. Review only matters for users outside the app's
// admin/test list.
//
// Token lifetime: Page access tokens, when issued via the
// /me/accounts dance, are long-lived (effectively non-expiring) as
// long as the user doesn't revoke. We still store token_expires_at
// if Meta returns one.
//
// Posting: POST /{page-id}/feed with `message=...` for plain text.
// Media variants come later; Phase 1 is text-only.

import { env } from "../../env";

const OAUTH_AUTHORIZE = "https://www.facebook.com/v21.0/dialog/oauth";
const OAUTH_TOKEN = "https://graph.facebook.com/v21.0/oauth/access_token";

function graphBase(): string {
  return `https://graph.facebook.com/${env.metaGraphVersion}`;
}

export const FACEBOOK_PAGE_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_manage_posts",
  "pages_read_engagement",
] as const;

// Facebook accepts ~63 206 chars per post; we cap at 5000 to match
// what most clients enforce and to keep latency sane.
export const FACEBOOK_MAX_CHARS = 5000;

export function getFacebookAuthorizeUrl(input: {
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
    scope: (input.scopes ?? FACEBOOK_PAGE_SCOPES).join(","),
  });
  return `${OAUTH_AUTHORIZE.replace("v21.0", env.metaGraphVersion)}?${params.toString()}`;
}

export type FacebookUserToken = {
  accessToken: string;
  expiresAt: Date | null;
};

export async function exchangeFacebookCode(input: {
  code: string;
  redirectUri: string;
}): Promise<FacebookUserToken> {
  const params = new URLSearchParams({
    client_id: env.metaAppId,
    client_secret: env.metaAppSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const url = `${OAUTH_TOKEN.replace("v21.0", env.metaGraphVersion)}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Facebook token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Facebook token exchange: missing access_token");
  }
  return {
    accessToken: json.access_token,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null,
  };
}

// /me/accounts returns the Pages the user manages, each with its own
// Page access token. That's what we post with, NOT the user token.
export type FacebookPage = {
  id: string;
  name: string;
  accessToken: string;
};

export async function listFacebookPages(input: {
  userAccessToken: string;
}): Promise<FacebookPage[]> {
  const url = new URL(`${graphBase()}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token");
  url.searchParams.set("access_token", input.userAccessToken);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Facebook /me/accounts ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; name?: string; access_token?: string }>;
  };
  return (json.data ?? [])
    .filter((p) => p.id && p.access_token)
    .map((p) => ({
      id: p.id!,
      name: p.name ?? "Untitled Page",
      accessToken: p.access_token!,
    }));
}

export type FacebookPostResult = {
  postId: string; // {page-id}_{post-id}
  webUrl: string;
};

export async function createFacebookPagePost(input: {
  pageId: string;
  pageAccessToken: string;
  text: string;
}): Promise<FacebookPostResult> {
  const message = input.text.slice(0, FACEBOOK_MAX_CHARS);
  const body = new URLSearchParams({
    message,
    access_token: input.pageAccessToken,
  });
  const res = await fetch(`${graphBase()}/${input.pageId}/feed`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Facebook /feed ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("Facebook /feed: missing id");
  // Composite id is `{page-id}_{post-id}`; the public permalink is
  // facebook.com/{page-id}/posts/{post-id}.
  const postIdOnly = json.id.includes("_") ? json.id.split("_")[1] : json.id;
  return {
    postId: json.id,
    webUrl: `https://www.facebook.com/${input.pageId}/posts/${postIdOnly}`,
  };
}
