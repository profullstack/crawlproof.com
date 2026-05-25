// Bluesky platform module (AT Protocol).
//
// Auth model: app passwords. The user goes to
// https://bsky.app/settings/app-passwords, generates an app password
// (format `xxxx-xxxx-xxxx-xxxx`), and pastes it into our connect form
// along with their handle. We exchange that for a session JWT
// (`accessJwt`) + refresh JWT (`refreshJwt`) via
// com.atproto.server.createSession.
//
// The JWTs go into sp_account.enc_access_token / enc_refresh_token
// after AES-GCM encryption via lib/sp/vault. The user's app password
// is NEVER stored — only the resulting JWTs.
//
// Posting: com.atproto.repo.createRecord with the app.bsky.feed.post
// collection. Returns the post's at:// URI + cid.

const DEFAULT_PDS = "https://bsky.social";

export type BlueskySession = {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
};

// Trade handle + app password for a session. Throws on failure with
// a readable message; caller maps to user-facing error.
export async function createBlueskySession(input: {
  handle: string;          // e.g. "chovy.bsky.social"
  appPassword: string;     // xxxx-xxxx-xxxx-xxxx
  pdsUrl?: string;         // PDS host; defaults to bsky.social
}): Promise<BlueskySession> {
  const pds = (input.pdsUrl ?? DEFAULT_PDS).replace(/\/$/, "");
  const handle = input.handle.trim().replace(/^@/, "");
  const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: input.appPassword }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bluesky createSession ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as Partial<BlueskySession>;
  if (!json.accessJwt || !json.refreshJwt || !json.did || !json.handle) {
    throw new Error("Bluesky createSession: missing fields in response");
  }
  return {
    accessJwt: json.accessJwt,
    refreshJwt: json.refreshJwt,
    did: json.did,
    handle: json.handle,
  };
}

// Refresh a session. Returns new {accessJwt, refreshJwt}. The DID and
// handle don't change; we only update the JWTs.
export async function refreshBlueskySession(input: {
  refreshJwt: string;
  pdsUrl?: string;
}): Promise<Pick<BlueskySession, "accessJwt" | "refreshJwt">> {
  const pds = (input.pdsUrl ?? DEFAULT_PDS).replace(/\/$/, "");
  const res = await fetch(`${pds}/xrpc/com.atproto.server.refreshSession`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.refreshJwt}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bluesky refreshSession ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    accessJwt?: string;
    refreshJwt?: string;
  };
  if (!json.accessJwt || !json.refreshJwt) {
    throw new Error("Bluesky refreshSession: missing fields");
  }
  return { accessJwt: json.accessJwt, refreshJwt: json.refreshJwt };
}

// Post a single text post. Bluesky's 300-char limit is enforced by
// the API — we trim client-side and document the limit to the user.
const MAX_POST_CHARS = 300;

export type BlueskyPostResult = {
  uri: string;      // at://did:plc:.../app.bsky.feed.post/...
  cid: string;
  webUrl: string;   // https://bsky.app/profile/{handle}/post/{rkey}
};

export async function createBlueskyPost(input: {
  accessJwt: string;
  did: string;
  handle: string;
  text: string;
  pdsUrl?: string;
}): Promise<BlueskyPostResult> {
  const pds = (input.pdsUrl ?? DEFAULT_PDS).replace(/\/$/, "");
  const text = input.text.slice(0, MAX_POST_CHARS);
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
  };
  const res = await fetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.accessJwt}`,
    },
    body: JSON.stringify({
      repo: input.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Bluesky createRecord ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { uri?: string; cid?: string };
  if (!json.uri || !json.cid) {
    throw new Error("Bluesky createRecord: missing uri/cid in response");
  }
  // at://did:.../app.bsky.feed.post/<rkey> → web URL
  const rkey = json.uri.split("/").pop() ?? "";
  return {
    uri: json.uri,
    cid: json.cid,
    webUrl: `https://bsky.app/profile/${input.handle}/post/${rkey}`,
  };
}

export const BLUESKY_MAX_CHARS = MAX_POST_CHARS;
