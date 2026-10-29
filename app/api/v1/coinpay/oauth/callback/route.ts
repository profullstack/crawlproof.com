import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  coinpayConfig,
  decodePending,
  fetchCoinpayClaims,
  mintMagicLinkHash,
  resolveCoinpayUser,
  stateMatches,
  supabaseCoinpayStore,
} from "@/lib/coinpay-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/coinpay/oauth/callback?code&state
// Checks state (cookie) and nonce (ID token), exchanges the code with PKCE,
// resolves the crawlproof user BY CoinPay sub (lib/coinpay-signin.ts), then
// either links (mode=connect, signed in) or signs in by redeeming a
// server-minted magic-link hash for that user's own email.
export async function GET(req: NextRequest) {
  const cfg = coinpayConfig();
  if (!cfg) return new NextResponse("Sign in with CoinPay is not configured.", { status: 503 });
  const sp = req.nextUrl.searchParams;
  const pending = decodePending(req.cookies.get(OAUTH_COOKIE)?.value);
  const back = (path: string, error?: string) => {
    const url = new URL(path, cfg.siteUrl);
    if (error) url.searchParams.set("error", error);
    const res = NextResponse.redirect(url, 302);
    res.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    return res;
  };
  const failPath = pending?.mode === "connect" ? "/dashboard/settings" : "/login";

  if (!pending) return back("/login", "CoinPay sign-in expired. Try again.");
  if (!stateMatches(pending.state, sp.get("state"))) {
    return back(failPath, "CoinPay sign-in failed: state mismatch.");
  }
  if (sp.get("error")) return back(failPath, `CoinPay: ${String(sp.get("error_description") || sp.get("error")).slice(0, 200)}`);
  const code = sp.get("code");
  if (!code) return back(failPath, "CoinPay sign-in failed: no code.");

  let claims;
  try {
    const r = await fetchCoinpayClaims(cfg, { code, verifier: pending.verifier, nonce: pending.nonce });
    if (!r.ok) return back(failPath, `CoinPay sign-in failed: ${r.error}.`);
    claims = r.claims;
  } catch (e) {
    console.error("[coinpay-signin] token/userinfo", e instanceof Error ? e.message : e);
    return back(failPath, "CoinPay did not answer. Try again.");
  }

  const supabase = await createClient();
  const { data: cur } = await supabase.auth.getUser();
  const sb = serviceClient();
  let resolved;
  try {
    resolved = await resolveCoinpayUser(
      { mode: pending.mode, currentUserId: cur.user?.id ?? null, claims },
      supabaseCoinpayStore(sb),
    );
  } catch (e) {
    console.error("[coinpay-signin] resolve", e instanceof Error ? e.message : e);
    return back(failPath, "CoinPay sign-in failed. Try again.");
  }
  if (!resolved.ok) return back(failPath, resolved.error);
  if (pending.mode === "connect") return back(`${pending.next}${pending.next.includes("?") ? "&" : "?"}coinpay=connected`);

  // Already signed in as that very user: nothing to mint.
  if (cur.user?.id === resolved.userId) return back(pending.next);
  if (cur.user) await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  const minted = await mintMagicLinkHash(sb, resolved.userId);
  if (!minted.ok) return back("/login", minted.error);
  const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: minted.tokenHash });
  if (error) {
    console.error("[coinpay-signin] verifyOtp", error.message);
    return back("/login", "Could not start your session. Try again.");
  }
  return back(pending.next);
}
