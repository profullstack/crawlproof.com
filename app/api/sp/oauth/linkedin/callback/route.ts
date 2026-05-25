// LinkedIn OAuth — step 2: callback.
// Validates state vs cookie, exchanges code for an access token, fetches
// OIDC /userinfo to get the member sub (used as urn:li:person:{sub} on
// every post). Upserts sp_account.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";
import {
  exchangeLinkedinCode,
  getLinkedinUserInfo,
} from "@/lib/sp/platforms/linkedin";

const STATE_COOKIE = "sp_linkedin_state";

function backWithError(message: string): NextResponse {
  const u = new URL("/social/setup", env.siteUrl);
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
    return backWithError(`LinkedIn declined: ${platformError}`);
  }
  if (!code || !state) {
    return backWithError("LinkedIn returned no authorization code.");
  }
  if (!cookieState || cookieState !== state) {
    return backWithError("OAuth state mismatch. Try again.");
  }

  const redirectUri = `${env.siteUrl}/api/sp/oauth/linkedin/callback`;

  let tokens;
  try {
    tokens = await exchangeLinkedinCode({ code, redirectUri });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "LinkedIn token exchange failed.",
    );
  }

  let me;
  try {
    me = await getLinkedinUserInfo({ accessToken: tokens.accessToken });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Could not read LinkedIn profile.",
    );
  }

  const { error: upsertErr } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "linkedin",
        auth_mode: "oauth",
        handle: me.name,
        external_id: me.sub,
        enc_access_token: encryptSecret(tokens.accessToken),
        token_expires_at: tokens.expiresAt.toISOString(),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    );
  if (upsertErr) {
    return backWithError(`Could not save account: ${upsertErr.message}`);
  }

  const ok = new URL("/social/setup", env.siteUrl);
  ok.searchParams.set("connected", "linkedin");
  const res = NextResponse.redirect(ok);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
