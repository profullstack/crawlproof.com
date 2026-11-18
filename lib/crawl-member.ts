import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

/**
 * The crawl gateway's `authenticate` hook: a VERIFIED, paying member reads
 * every public page even while the site-wide swarm gate (x402-gateway
 * massScrape) is answering anonymous page loads with 402. Before this hook a
 * signed-in admin opening /rankings/... in a browser got the CrawlPass page,
 * because the swarm gate runs before `exempt` and crawlproof had no verified
 * credential to offer it.
 *
 * Who passes (Anthony, 2026-11-14: no blanket sign-in bypass, free accounts
 * pay): an admin, a pro/team plan, an active Profullstack Pass, or anyone who
 * has completed a credit purchase. Everyone else, signed in or not, carries on
 * to the gate as before.
 *
 * Only ever answers true or null, never false: a stale or forged session
 * cookie on a page view should meet the normal gate, not a 401.
 *
 * The session is checked with supabase.auth.getUser(), which asks Supabase
 * Auth; a cookie that is merely present proves nothing. Verdicts are cached
 * for a minute per session cookie so a member browsing does not cost an Auth
 * round trip per page.
 *
 * Env is read through a non-literal key: Next inlines `process.env.NAME` at
 * build time in the proxy bundle, and the service-role key is a runtime secret.
 */
const env = (name: string) => process.env[name];

export type MemberRow = {
  is_admin?: boolean | null;
  plan?: string | null;
};

export interface MemberStore {
  profile(userId: string): Promise<MemberRow | null>;
  hasCompletedPurchase(userId: string): Promise<boolean>;
  passActive(userId: string, now: Date): Promise<boolean>;
}

export async function isPayingMember(store: MemberStore, userId: string, now = new Date()): Promise<boolean> {
  const profile = await store.profile(userId);
  if (profile?.is_admin) return true;
  if (profile?.plan === "pro" || profile?.plan === "team") return true;
  if (await store.passActive(userId, now)) return true;
  return store.hasCompletedPurchase(userId);
}

function supabaseMemberStore(sb: SupabaseClient): MemberStore {
  return {
    async profile(userId) {
      const { data } = await sb.from("profiles").select("is_admin, plan").eq("id", userId).maybeSingle();
      return (data as MemberRow | null) ?? null;
    },
    async hasCompletedPurchase(userId) {
      const { data } = await sb
        .from("credit_purchases")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "complete")
        .limit(1);
      return Boolean(data?.length);
    },
    async passActive(userId, now) {
      const { data } = await sb
        .from("coinpay_identities")
        .select("pass_until")
        .eq("user_id", userId)
        .gt("pass_until", now.toISOString())
        .limit(1);
      return Boolean(data?.length);
    },
  };
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { verdict: boolean; until: number }>();

/** The Supabase auth cookies (sb-<ref>-auth-token, possibly chunked .0/.1). */
export function authCookies(cookieHeader: string | null): { name: string; value: string }[] {
  if (!cookieHeader) return [];
  return parseCookieHeader(cookieHeader)
    .filter((c): c is { name: string; value: string } => typeof c.value === "string")
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name));
}

let service: SupabaseClient | null = null;

export async function authenticateMember(
  request: Request,
  deps: {
    getUserId?: (cookies: { name: string; value: string }[]) => Promise<string | null>;
    store?: MemberStore;
    now?: () => number;
  } = {},
): Promise<true | null> {
  try {
    const cookies = authCookies(request.headers.get("cookie"));
    if (!cookies.length) return null;

    const now = deps.now ?? Date.now;
    const key = createHash("sha256").update(cookies.map((c) => `${c.name}=${c.value}`).join(";")).digest("base64url");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.verdict ? true : null;

    const userId = await (deps.getUserId ?? verifiedUserId)(cookies);
    let verdict = false;
    if (userId) {
      const store = deps.store ?? serviceStore();
      verdict = store ? await isPayingMember(store, userId, new Date(now())) : false;
    }
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { verdict, until: now() + TTL_MS });
    return verdict ? true : null;
  } catch {
    return null;
  }
}

function serviceStore(): MemberStore | null {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  service ??= createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return supabaseMemberStore(service);
}

async function verifiedUserId(cookies: { name: string; value: string }[]): Promise<string | null> {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !anon) return null;
  // Read-only: the proxy's own client refreshes and rewrites the session
  // later in the request; this one only asks Supabase Auth who it is.
  const sb = createServerClient(url, anon, {
    cookies: { getAll: () => cookies, setAll: () => {} },
  });
  const { data, error } = await sb.auth.getUser();
  return error ? null : data.user?.id ?? null;
}

/** Test hook. */
export function _clearMemberCache(): void {
  cache.clear();
}
