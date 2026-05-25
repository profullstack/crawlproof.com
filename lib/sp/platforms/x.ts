// X (Twitter) platform module — OAuth2 User Context with PKCE.
//
// Auth model: standard OAuth2 authorization code + PKCE. X registers
// every app as a confidential client (i.e. requires client_secret in
// addition to PKCE). Scopes:
//   - `tweet.read`        — minimum to call /users/me
//   - `tweet.write`       — POST /2/tweets
//   - `users.read`        — fetch the authenticated user's username
//   - `offline.access`    — issues refresh_token
//
// Tier note: writes require X API Basic tier ($200/mo) or higher as of
// 2024. The OAuth flow itself works on Free, but `POST /2/tweets`
// returns 403 with `403 OAuth2UserToken is not permitted to access this
// resource` until you upgrade. Code is paid-tier-ready; usage is gated
// on the user's billing decision.
//
// Token lifetime: access_token expires in 2h. refresh_token rotates on
// every refresh — we always persist the latest one.

import { env } from "../../env";

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const API_BASE = "https://api.twitter.com/2";

export const X_DEFAULT_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "offline.access",
] as const;

export const X_MAX_CHARS = 280;

function basicAuth(): string {
  return (
    "Basic " +
    Buffer.from(`${env.xClientId}:${env.xClientSecret}`).toString("base64")
  );
}

export function getXAuthorizeUrl(input: {
  state: string;
  codeChallenge: string; // PKCE challenge (S256)
  redirectUri: string;
  scopes?: readonly string[];
}): string {
  if (!env.xClientId) throw new Error("X_CLIENT_ID not configured.");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.xClientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? X_DEFAULT_SCOPES).join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export type XTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
};

export async function exchangeXCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: env.xClientId,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuth(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`X token exchange ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token || !json.expires_in) {
    throw new Error("X token exchange: missing fields");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: json.scope ?? "",
  };
}

// X's refresh tokens are rotating — every refresh issues a new
// refresh_token; the old one is invalidated. Caller MUST persist both.
export async function refreshXToken(input: {
  refreshToken: string;
}): Promise<XTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: env.xClientId,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: basicAuth(),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`X refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token || !json.expires_in) {
    throw new Error("X refresh: missing fields");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? input.refreshToken,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: json.scope ?? "",
  };
}

export type XUserMe = {
  id: string;
  name: string;
  username: string;
};

export async function getXMe(input: {
  accessToken: string;
}): Promise<XUserMe> {
  const res = await fetch(`${API_BASE}/users/me`, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`X /users/me ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: { id?: string; name?: string; username?: string };
  };
  if (!json.data?.id || !json.data.username) {
    throw new Error("X /users/me: missing data fields");
  }
  return {
    id: json.data.id,
    name: json.data.name ?? json.data.username,
    username: json.data.username,
  };
}

export type XPostResult = {
  tweetId: string;
  webUrl: string;
};

export async function createTweet(input: {
  accessToken: string;
  username: string;
  text: string;
}): Promise<XPostResult> {
  const text = input.text.slice(0, X_MAX_CHARS);
  const res = await fetch(`${API_BASE}/tweets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`X /2/tweets ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: { id?: string; text?: string };
    errors?: Array<{ message?: string }>;
  };
  if (!json.data?.id) {
    const msg = json.errors?.[0]?.message ?? "missing tweet id";
    throw new Error(`X tweet refused: ${msg}`);
  }
  return {
    tweetId: json.data.id,
    webUrl: `https://x.com/${input.username}/status/${json.data.id}`,
  };
}
