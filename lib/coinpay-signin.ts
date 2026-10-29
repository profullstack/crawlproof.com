// Sign in with CoinPay (CoinPay is the house master account).
//
// Confidential OIDC client: authorization code + PKCE S256 + state + nonce,
// redirect https://crawlproof.com/api/v1/coinpay/oauth/callback, scopes
// "openid profile email".
//
// STANDING security rule: a CoinPay login binds to the CoinPay `sub` in
// public.coinpay_identities. It never signs in to an existing account because
// the CoinPay email matches (CoinPay never verifies emails), never stores that
// email as the account's (confirmed) email, and never grants anything from it.
// Linking CoinPay to an existing account happens only from Settings while
// signed in to it. A first CoinPay login with no link creates a NEW crawlproof
// account whose auth email is a random placeholder; the CoinPay email is kept
// as unverified contact info on the identity row.
//
// The decision logic is written against small interfaces so tests run in
// memory; supabaseCoinpayStore() is the real one.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const COINPAY_ISSUER = "https://coinpayportal.com";
export const COINPAY_SCOPES = "openid profile email";
export const CALLBACK_PATH = "/api/v1/coinpay/oauth/callback";
export const OAUTH_COOKIE = "cp_oauth";
export const OAUTH_COOKIE_PATH = "/api/v1/coinpay/oauth";
export const OAUTH_COOKIE_MAX_AGE = 600;
/** Auth emails of accounts a CoinPay login created. Nobody receives mail here. */
export const PLACEHOLDER_EMAIL_DOMAIN = "coinpay-users.crawlproof.com";

// Read at request time with bracket access: Next inlines `process.env.NAME`
// at build time, server code included, which would bake a missing secret in.
function runtimeEnv(name: string): string {
  const v = (process.env as Record<string, string | undefined>)[name];
  return typeof v === "string" ? v.trim() : "";
}

export type CoinpayConfig = { clientId: string; clientSecret: string; issuer: string; siteUrl: string };

export function coinpayConfig(): CoinpayConfig | null {
  const clientId = runtimeEnv("COINPAY_OAUTH_CLIENT_ID");
  const clientSecret = runtimeEnv("COINPAY_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const issuer = (runtimeEnv("COINPAY_OAUTH_ISSUER") || COINPAY_ISSUER).replace(/\/+$/, "");
  const siteUrl = (runtimeEnv("NEXT_PUBLIC_SITE_URL") || "https://crawlproof.com").replace(/\/+$/, "");
  return { clientId, clientSecret, issuer, siteUrl };
}

export function redirectUri(cfg: Pick<CoinpayConfig, "siteUrl">): string {
  return cfg.siteUrl + CALLBACK_PATH;
}

const b64url = (b: Buffer) => b.toString("base64url");

export type OAuthMode = "login" | "connect";

/** What the start route keeps in the short-lived httpOnly cookie. */
export type PendingAuth = { state: string; verifier: string; nonce: string; mode: OAuthMode; next: string };

export function newPendingAuth(mode: OAuthMode, next: string): PendingAuth & { challenge: string } {
  const verifier = b64url(randomBytes(32));
  return {
    state: b64url(randomBytes(24)),
    verifier,
    nonce: b64url(randomBytes(24)),
    mode,
    next: safeNext(next, mode),
    challenge: b64url(createHash("sha256").update(verifier).digest()),
  };
}

export function encodePending(p: PendingAuth): string {
  return Buffer.from(JSON.stringify({ s: p.state, v: p.verifier, n: p.nonce, m: p.mode, r: p.next })).toString("base64url");
}

export function decodePending(raw: string | null | undefined): PendingAuth | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!o || typeof o.s !== "string" || typeof o.v !== "string" || typeof o.n !== "string") return null;
    if (o.m !== "login" && o.m !== "connect") return null;
    return { state: o.s, verifier: o.v, nonce: o.n, mode: o.m, next: safeNext(String(o.r ?? ""), o.m) };
  } catch {
    return null;
  }
}

/** Only same-site paths; anything else falls back to the default landing. */
export function safeNext(next: string | null | undefined, mode: OAuthMode = "login"): string {
  const fallback = mode === "connect" ? "/dashboard/settings" : "/dashboard";
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n\t]/.test(next)) return fallback;
  if (next.length > 512) return fallback;
  return next;
}

export function authorizeUrl(cfg: CoinpayConfig, p: PendingAuth & { challenge: string }): string {
  const url = new URL("/api/oauth/authorize", cfg.issuer);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(cfg),
    scope: COINPAY_SCOPES,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Constant-time compare of the returned state with the cookie's. */
export function stateMatches(expected: string | null | undefined, got: string | null | undefined): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type CoinpayClaims = { sub: string; email: string | null; name: string | null };

/**
 * Check the ID token that came straight back from the token endpoint over TLS
 * (OIDC Core 3.1.3.7: TLS server validation stands in for the signature,
 * which CoinPay makes with its own HS256 secret). Issuer, audience, expiry and
 * nonce must match; the sub must equal userinfo's.
 */
export function checkIdToken(
  idToken: unknown,
  want: { issuer: string; clientId: string; nonce: string; sub: string; now?: number },
): { ok: true } | { ok: false; error: string } {
  if (typeof idToken !== "string") return { ok: false, error: "no id_token" };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed id_token" };
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed id_token" };
  }
  const now = Math.floor((want.now ?? Date.now()) / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (String(c.iss ?? "").replace(/\/+$/, "") !== want.issuer.replace(/\/+$/, "")) return { ok: false, error: "id_token issuer mismatch" };
  if (!aud.includes(want.clientId)) return { ok: false, error: "id_token audience mismatch" };
  if (typeof c.exp !== "number" || c.exp < now - 60) return { ok: false, error: "id_token expired" };
  if (!stateMatches(want.nonce, typeof c.nonce === "string" ? c.nonce : null)) return { ok: false, error: "nonce mismatch" };
  if (c.sub !== want.sub) return { ok: false, error: "id_token subject mismatch" };
  return { ok: true };
}

/** Code -> tokens -> userinfo, with the ID token checked. */
export async function fetchCoinpayClaims(
  cfg: CoinpayConfig,
  input: { code: string; verifier: string; nonce: string },
  doFetch: typeof fetch = fetch,
): Promise<{ ok: true; claims: CoinpayClaims } | { ok: false; error: string }> {
  const tokenRes = await doFetch(cfg.issuer + "/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: redirectUri(cfg),
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!tokenRes.ok || typeof tok.access_token !== "string") return { ok: false, error: "CoinPay refused the code" };
  const infoRes = await doFetch(cfg.issuer + "/api/oauth/userinfo", {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const info = (await infoRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!infoRes.ok || typeof info.sub !== "string" || !info.sub) return { ok: false, error: "CoinPay userinfo failed" };
  const idc = checkIdToken(tok.id_token, { issuer: cfg.issuer, clientId: cfg.clientId, nonce: input.nonce, sub: info.sub });
  if (!idc.ok) return idc;
  return {
    ok: true,
    claims: {
      sub: info.sub,
      email: typeof info.email === "string" && info.email.includes("@") ? info.email.slice(0, 320) : null,
      name: typeof info.name === "string" && info.name.trim() ? info.name.trim().slice(0, 200) : null,
    },
  };
}

// ---------------------------------------------------------------- store

export type IdentityRow = { user_id: string; coinpay_sub: string; coinpay_email: string | null; created_via: "connect" | "signup" };

export interface CoinpayStore {
  identityBySub(sub: string): Promise<IdentityRow | null>;
  identityByUser(userId: string): Promise<IdentityRow | null>;
  /** Insert; "conflict" when the sub or the user is already bound. */
  link(row: IdentityRow & { coinpay_name: string | null }): Promise<"ok" | "conflict">;
  unlink(userId: string): Promise<void>;
  touch(sub: string): Promise<void>;
  /** A brand-new auth user with a random placeholder email (confirmed: it is ours). */
  createUser(input: { name: string | null; contactEmail: string | null }): Promise<string>;
  deleteUser(userId: string): Promise<void>;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith("@" + PLACEHOLDER_EMAIL_DOMAIN);
}

export function placeholderEmail(): string {
  return `cp-${randomBytes(12).toString("hex")}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export type Resolution =
  | { ok: true; userId: string; action: "login" | "created" | "linked" }
  | { ok: false; error: string; code: "not_signed_in" | "linked_elsewhere" | "already_connected" };

/**
 * Decide which crawlproof user a verified CoinPay sub belongs to. Never looks
 * at the email: a CoinPay login whose email equals an existing user's gets a
 * NEW account (or the one already bound to its sub), never that user's.
 */
export async function resolveCoinpayUser(
  input: { mode: OAuthMode; currentUserId: string | null; claims: CoinpayClaims },
  store: CoinpayStore,
): Promise<Resolution> {
  const { claims } = input;
  const bound = await store.identityBySub(claims.sub);

  if (input.mode === "connect") {
    if (!input.currentUserId) return { ok: false, code: "not_signed_in", error: "Sign in to crawlproof first, then connect CoinPay from Settings." };
    if (bound) {
      if (bound.user_id === input.currentUserId) return { ok: true, userId: bound.user_id, action: "linked" };
      return { ok: false, code: "linked_elsewhere", error: "That CoinPay account is already connected to another crawlproof account." };
    }
    const mine = await store.identityByUser(input.currentUserId);
    if (mine) return { ok: false, code: "already_connected", error: "This crawlproof account is already connected to a different CoinPay account. Disconnect it first." };
    const r = await store.link({
      user_id: input.currentUserId,
      coinpay_sub: claims.sub,
      coinpay_email: claims.email,
      coinpay_name: claims.name,
      created_via: "connect",
    });
    if (r === "conflict") return { ok: false, code: "linked_elsewhere", error: "That CoinPay account was just connected elsewhere." };
    return { ok: true, userId: input.currentUserId, action: "linked" };
  }

  if (bound) {
    await store.touch(claims.sub);
    return { ok: true, userId: bound.user_id, action: "login" };
  }
  const userId = await store.createUser({ name: claims.name, contactEmail: claims.email });
  const r = await store.link({ user_id: userId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: "signup" });
  if (r === "conflict") {
    // Lost a race with a parallel first login for the same sub: keep theirs.
    await store.deleteUser(userId).catch(() => {});
    const again = await store.identityBySub(claims.sub);
    if (again) return { ok: true, userId: again.user_id, action: "login" };
    throw new Error("coinpay identity conflict");
  }
  return { ok: true, userId, action: "created" };
}

/** Disconnect is refused when CoinPay is the only way into the account. */
export async function disconnectCoinpay(
  userId: string,
  authEmail: string | null,
  store: CoinpayStore,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const mine = await store.identityByUser(userId);
  if (!mine) return { ok: true };
  if (!authEmail || isPlaceholderEmail(authEmail)) {
    return { ok: false, error: "CoinPay is the only way to sign in to this account, so it cannot be disconnected." };
  }
  await store.unlink(userId);
  return { ok: true };
}

export function supabaseCoinpayStore(sb: SupabaseClient): CoinpayStore {
  const cols = "user_id, coinpay_sub, coinpay_email, created_via";
  return {
    async identityBySub(sub) {
      const r = await sb.from("coinpay_identities").select(cols).eq("coinpay_sub", sub).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as IdentityRow | null) ?? null;
    },
    async identityByUser(userId) {
      const r = await sb.from("coinpay_identities").select(cols).eq("user_id", userId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as IdentityRow | null) ?? null;
    },
    async link(row) {
      const r = await sb.from("coinpay_identities").insert({ ...row, last_login_at: new Date().toISOString() });
      if (r.error) {
        if (r.error.code === "23505") return "conflict";
        throw new Error(r.error.message);
      }
      return "ok";
    },
    async unlink(userId) {
      const r = await sb.from("coinpay_identities").delete().eq("user_id", userId);
      if (r.error) throw new Error(r.error.message);
    },
    async touch(sub) {
      await sb.from("coinpay_identities").update({ last_login_at: new Date().toISOString() }).eq("coinpay_sub", sub);
    },
    async createUser({ name, contactEmail }) {
      const [first, ...rest] = (name ?? "").split(/\s+/).filter(Boolean);
      const r = await sb.auth.admin.createUser({
        email: placeholderEmail(),
        email_confirm: true,
        user_metadata: {
          full_name: name ?? "CoinPay user",
          ...(first ? { first_name: first } : {}),
          ...(rest.length ? { last_name: rest.join(" ") } : {}),
          signup_via: "coinpay",
          // Unverified contact info from CoinPay. Never an identity.
          ...(contactEmail ? { coinpay_contact_email: contactEmail } : {}),
        },
        app_metadata: { signup_via: "coinpay" },
      });
      if (r.error || !r.data.user) throw new Error(r.error?.message ?? "createUser failed");
      return r.data.user.id;
    },
    async deleteUser(userId) {
      await sb.auth.admin.deleteUser(userId);
    },
  };
}

/**
 * A magic-link token hash for the user's OWN auth email, minted server side
 * (nothing is emailed). The caller redeems it with verifyOtp on the cookie
 * client, which sets the normal Supabase session cookies. Refuses an account
 * whose email is not confirmed: redeeming the link would confirm it.
 */
export async function mintMagicLinkHash(sb: SupabaseClient, userId: string): Promise<{ ok: true; tokenHash: string } | { ok: false; error: string }> {
  const u = await sb.auth.admin.getUserById(userId);
  const user = u.data?.user;
  if (u.error || !user?.email) return { ok: false, error: "account not found" };
  if (!user.email_confirmed_at) return { ok: false, error: "Confirm this account's email before signing in with CoinPay." };
  const link = await sb.auth.admin.generateLink({ type: "magiclink", email: user.email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return { ok: false, error: "could not start a session" };
  return { ok: true, tokenHash };
}
