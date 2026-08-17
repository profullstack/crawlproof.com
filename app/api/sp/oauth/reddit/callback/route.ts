// Reddit OAuth — step 2: callback.
// Reddit redirects here with `code` + `state` after the user grants
// consent. We verify the state against the cookie set in /start, trade
// the code for tokens, fetch the username via /api/v1/me, then upsert
// into sp_account.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";
import {
  exchangeRedditCode,
  getRedditMe,
} from "@/lib/sp/platforms/reddit";

const STATE_COOKIE = "sp_reddit_state";

function backWithError(message: string): NextResponse {
  const u = new URL("/dashboard/social/setup", env.siteUrl);
  u.searchParams.set("error", message);
  const res = NextResponse.redirect(u);
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", env.siteUrl));
  }

  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const platformError = params.get("error");
  const cookieState = req.cookies.get(STATE_COOKIE)?.value;

  if (platformError) {
    return backWithError(`Reddit declined: ${platformError}`);
  }
  if (!code || !state) {
    return backWithError("Reddit returned no authorization code.");
  }
  if (!cookieState || cookieState !== state) {
    return backWithError("OAuth state mismatch. Try again.");
  }

  const redirectUri = `${env.siteUrl}/api/sp/oauth/reddit/callback`;

  let tokens;
  try {
    tokens = await exchangeRedditCode({ code, redirectUri });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Reddit token exchange failed.",
    );
  }

  let me;
  try {
    me = await getRedditMe({ accessToken: tokens.accessToken });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Could not read Reddit profile.",
    );
  }

  const { error: upsertErr } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "reddit",
        auth_mode: "oauth",
        handle: me.name,
        external_id: me.id,
        enc_access_token: encryptSecret(tokens.accessToken),
        enc_refresh_token: encryptSecret(tokens.refreshToken),
        token_expires_at: tokens.expiresAt.toISOString(),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    );
  if (upsertErr) {
    return backWithError(`Could not save account: ${upsertErr.message}`);
  }

  const ok = new URL("/dashboard/social/setup", env.siteUrl);
  ok.searchParams.set("connected", "reddit");
  const res = NextResponse.redirect(ok);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
