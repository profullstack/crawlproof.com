// X (Twitter) OAuth — step 2: callback.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";
import { exchangeXCode, getXMe } from "@/lib/sp/platforms/x";

const STATE_COOKIE = "sp_x_state";

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
  const cookieRaw = req.cookies.get(STATE_COOKIE)?.value;

  if (platformError) return backWithError(`X declined: ${platformError}`);
  if (!code || !state || !cookieRaw) {
    return backWithError("X returned no authorization code.");
  }

  let parsed: { s: string; v: string };
  try {
    parsed = JSON.parse(Buffer.from(cookieRaw, "base64url").toString("utf8"));
  } catch {
    return backWithError("X OAuth state cookie is malformed.");
  }
  if (parsed.s !== state) {
    return backWithError("OAuth state mismatch. Try again.");
  }

  const redirectUri = `${env.siteUrl}/api/sp/oauth/x/callback`;

  let tokens;
  try {
    tokens = await exchangeXCode({
      code,
      codeVerifier: parsed.v,
      redirectUri,
    });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "X token exchange failed.",
    );
  }

  let me;
  try {
    me = await getXMe({ accessToken: tokens.accessToken });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Could not read X profile.",
    );
  }

  const { error: upsertErr } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "x",
        auth_mode: "oauth",
        handle: `@${me.username}`,
        external_id: me.id,
        enc_access_token: encryptSecret(tokens.accessToken),
        enc_refresh_token: tokens.refreshToken
          ? encryptSecret(tokens.refreshToken)
          : null,
        token_expires_at: tokens.expiresAt.toISOString(),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    );
  if (upsertErr) {
    return backWithError(`Could not save account: ${upsertErr.message}`);
  }

  const ok = new URL("/dashboard/social/setup", env.siteUrl);
  ok.searchParams.set("connected", "x");
  const res = NextResponse.redirect(ok);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
