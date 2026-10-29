import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_COOKIE_PATH,
  authorizeUrl,
  coinpayConfig,
  encodePending,
  newPendingAuth,
} from "@/lib/coinpay-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/coinpay/oauth/start?mode=login|connect&next=/path
// 302 to CoinPay authorize with PKCE S256, state and nonce kept in a
// short-lived httpOnly cookie scoped to the OAuth routes. mode=connect links
// CoinPay to the signed-in account (Settings); it needs a session.
export async function GET(req: NextRequest) {
  const cfg = coinpayConfig();
  if (!cfg) return new NextResponse("Sign in with CoinPay is not configured.", { status: 503 });
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("mode") === "connect" ? "connect" : "login";
  if (mode === "connect") {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      const login = new URL("/login", cfg.siteUrl);
      login.searchParams.set("redirect", "/dashboard/settings");
      return NextResponse.redirect(login, 302);
    }
  }
  const pending = newPendingAuth(mode, sp.get("next") ?? "");
  const res = NextResponse.redirect(authorizeUrl(cfg, pending), 302);
  res.cookies.set(OAUTH_COOKIE, encodePending(pending), {
    httpOnly: true,
    secure: cfg.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
