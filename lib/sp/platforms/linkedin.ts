// LinkedIn platform module (OAuth2 web flow + UGC text post).
//
// Auth model: standard OAuth2 authorization code flow. Scopes:
//   - `openid profile email` — OIDC userinfo (we use `sub` as the
//     person URN for posting authorship).
//   - `w_member_social` — post on behalf of the signed-in member.
//
// Both scopes auto-enable on a fresh dev app under the "Sign In with
// LinkedIn using OpenID Connect" + "Share on LinkedIn" products. No
// LinkedIn app review needed for these.
//
// Token shape: access tokens last 60 days. Refresh tokens are only
// issued to Marketing Developer Platform partners — so we DON'T get
// one with these scopes. When a token expires we re-auth the user;
// expiry is far enough out that this is a once-every-two-months prompt.
//
// Posting: POST /v2/ugcPosts. The newer versioned /rest/posts endpoint
// is what LinkedIn now recommends, but it requires the LinkedIn-Version
// header which changes every few months — /v2/ugcPosts is still live,
// stable, and avoids the version-pinning maintenance tax for Phase 1.

import { env } from "../../env";

const OAUTH_AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
const OAUTH_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const API_USERINFO = "https://api.linkedin.com/v2/userinfo";
const API_UGC_POSTS = "https://api.linkedin.com/v2/ugcPosts";

export const LINKEDIN_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "w_member_social",
] as const;

// LinkedIn ShareCommentary hard limit. (The marketing API allows
// longer, but UGC text posts are clamped.)
export const LINKEDIN_MAX_CHARS = 3000;

export function getLinkedinAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}): string {
  if (!env.linkedinClientId) {
    throw new Error("LINKEDIN_CLIENT_ID not configured.");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.linkedinClientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: (input.scopes ?? LINKEDIN_DEFAULT_SCOPES).join(" "),
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

export type LinkedinTokenResponse = {
  accessToken: string;
  expiresAt: Date;
  scope: string;
};

export async function exchangeLinkedinCode(input: {
  code: string;
  redirectUri: string;
}): Promise<LinkedinTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: env.linkedinClientId,
    client_secret: env.linkedinClientSecret,
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token || !json.expires_in) {
    throw new Error("LinkedIn token exchange: missing fields in response");
  }
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: json.scope ?? "",
  };
}

export type LinkedinUserInfo = {
  sub: string; // member URN id (we wrap as urn:li:person:{sub} on post)
  name: string;
  email: string | null;
};

// OIDC-style /v2/userinfo. Returns the same shape as Google's userinfo.
export async function getLinkedinUserInfo(input: {
  accessToken: string;
}): Promise<LinkedinUserInfo> {
  const res = await fetch(API_USERINFO, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn /userinfo ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    sub?: string;
    name?: string;
    email?: string;
  };
  if (!json.sub) throw new Error("LinkedIn /userinfo: missing sub.");
  return {
    sub: json.sub,
    name: json.name ?? json.sub,
    email: json.email ?? null,
  };
}

export type LinkedinPostResult = {
  urn: string; // e.g. urn:li:ugcPost:7123456789012345678
  webUrl: string;
};

export async function createLinkedinTextPost(input: {
  accessToken: string;
  memberSub: string;
  text: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
}): Promise<LinkedinPostResult> {
  const text = input.text.slice(0, LINKEDIN_MAX_CHARS);
  const body = {
    author: `urn:li:person:${input.memberSub}`,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": input.visibility ?? "PUBLIC",
    },
  };
  const res = await fetch(API_UGC_POSTS, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
      // LinkedIn ignores requests without this header on the v2 API.
      "x-restli-protocol-version": "2.0.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LinkedIn /ugcPosts ${res.status}: ${text.slice(0, 200)}`);
  }
  // LinkedIn returns the new URN either in the response body's `id` or
  // in the `x-restli-id` header. We prefer the body but fall back.
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  const urn = json.id ?? res.headers.get("x-restli-id") ?? "";
  if (!urn) {
    throw new Error("LinkedIn /ugcPosts: response missing post URN.");
  }
  return {
    urn,
    webUrl: `https://www.linkedin.com/feed/update/${urn}/`,
  };
}
