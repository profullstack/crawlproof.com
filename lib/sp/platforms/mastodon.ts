// Mastodon platform module.
//
// Auth model: federated OAuth2. Each Mastodon instance is its own OAuth
// provider, so we register a Crawlproof app on every new instance via
// POST /api/v1/apps the first time anyone connects there. The returned
// {client_id, client_secret, redirect_uri} are cached in sp_mastodon_app
// (with AES-GCM-encrypted client_secret) and reused for every future
// user connecting to that instance.
//
// Auth flow:
//   1. User types an instance URL (e.g. "https://mastodon.social")
//   2. We POST /api/v1/apps if we haven't already → cache
//   3. Redirect user to {instance}/oauth/authorize?response_type=code...
//   4. Instance redirects back with code → POST /oauth/token → access_token
//   5. GET /api/v1/accounts/verify_credentials → username, account id
//
// Tokens are long-lived (no refresh flow in classic Mastodon — the access
// token doesn't expire unless the user revokes it from their instance).
//
// Posting: POST /api/v1/statuses with `status` (text). Phase 1 is text-only;
// media + threads (`in_reply_to_id`) ship later.

// Per Mastodon's default config:
//   https://docs.joinmastodon.org/user/posting/#status
// Most instances cap at 500 chars; some (Pleroma forks) go much higher.
// 500 is the conservative ceiling we expose in the UI.
export const MASTODON_DEFAULT_MAX_CHARS = 500;

export const MASTODON_DEFAULT_SCOPES = ["read", "write:statuses"] as const;

function normalizeInstance(input: string): string {
  let url = input.trim();
  if (!url) throw new Error("Mastodon instance URL is required.");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, "");
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error("Mastodon instance URL is malformed.");
  }
}

export type MastodonAppRegistration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

// Register a Crawlproof app on a Mastodon instance. Idempotent from the
// instance's perspective — calling /api/v1/apps twice gets you two
// separate app rows. The caller is responsible for caching the result in
// sp_mastodon_app so we never register twice for the same instance.
export async function registerMastodonApp(input: {
  instanceUrl: string;
  redirectUri: string;
  clientName?: string;
  website?: string;
  scopes?: readonly string[];
}): Promise<MastodonAppRegistration> {
  const instance = normalizeInstance(input.instanceUrl);
  const body = new URLSearchParams({
    client_name: input.clientName ?? "Crawlproof",
    redirect_uris: input.redirectUri,
    scopes: (input.scopes ?? MASTODON_DEFAULT_SCOPES).join(" "),
    website: input.website ?? "https://crawlproof.com",
  });
  const res = await fetch(`${instance}/api/v1/apps`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mastodon /api/v1/apps ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    client_id?: string;
    client_secret?: string;
    redirect_uri?: string;
  };
  if (!json.client_id || !json.client_secret) {
    throw new Error("Mastodon /api/v1/apps: missing client_id / client_secret");
  }
  return {
    clientId: json.client_id,
    clientSecret: json.client_secret,
    redirectUri: json.redirect_uri ?? input.redirectUri,
  };
}

export function getMastodonAuthorizeUrl(input: {
  instanceUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const instance = normalizeInstance(input.instanceUrl);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? MASTODON_DEFAULT_SCOPES).join(" "),
    state: input.state,
  });
  return `${instance}/oauth/authorize?${params.toString()}`;
}

export async function exchangeMastodonCode(input: {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  scopes?: readonly string[];
}): Promise<{ accessToken: string; scope: string }> {
  const instance = normalizeInstance(input.instanceUrl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
    scope: (input.scopes ?? MASTODON_DEFAULT_SCOPES).join(" "),
  });
  const res = await fetch(`${instance}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mastodon /oauth/token ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) {
    throw new Error("Mastodon /oauth/token: missing access_token");
  }
  return { accessToken: json.access_token, scope: json.scope ?? "" };
}

export async function getMastodonMe(input: {
  instanceUrl: string;
  accessToken: string;
}): Promise<{ id: string; username: string; acct: string }> {
  const instance = normalizeInstance(input.instanceUrl);
  const res = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mastodon verify_credentials ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    id?: string;
    username?: string;
    acct?: string;
  };
  if (!json.id || !json.username) {
    throw new Error("Mastodon verify_credentials: missing id/username");
  }
  return {
    id: json.id,
    username: json.username,
    acct: json.acct ?? json.username,
  };
}

export type MastodonPostResult = {
  id: string;
  webUrl: string;
};

export async function createMastodonStatus(input: {
  instanceUrl: string;
  accessToken: string;
  status: string;
}): Promise<MastodonPostResult> {
  const instance = normalizeInstance(input.instanceUrl);
  const body = new URLSearchParams({ status: input.status });
  const res = await fetch(`${instance}/api/v1/statuses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
      // Mastodon's per-status idempotency header. Without it a duplicate POST
      // (browser retry, network glitch) creates a second status.
      "idempotency-key": crypto.randomUUID(),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mastodon /api/v1/statuses ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { id?: string; url?: string; uri?: string };
  if (!json.id || !json.url) {
    throw new Error("Mastodon /api/v1/statuses: missing id/url");
  }
  return { id: json.id, webUrl: json.url };
}

export { normalizeInstance as normalizeMastodonInstance };
