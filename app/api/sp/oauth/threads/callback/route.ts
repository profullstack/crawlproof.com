// Threads OAuth — step 2: callback.
// Exchanges code for a short-lived token, then immediately upgrades to a
// long-lived token (~60d) so we don't carry a sub-hour expiry. Looks up
// /me for the username (used in the post permalink) and upserts sp_account.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";
import {
  exchangeThreadsCode,
  exchangeForLongLivedThreadsToken,
  getThreadsMe,
} from "@/lib/sp/platforms/threads";

const STATE_COOKIE = "sp_threads_state";

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
  if (!user) return NextResponse.redirect(new URL("/login", env.siteUrl));

  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const platformError = params.get("error");
  const cookieState = req.cookies.get(STATE_COOKIE)?.value;

  if (platformError) return backWithError(`Threads declined: ${platformError}`);
  if (!code || !state) return backWithError("Threads returned no code.");
  if (!cookieState || cookieState !== state) {
    return backWithError("OAuth state mismatch. Try again.");
  }

  const redirectUri = `${env.siteUrl}/api/sp/oauth/threads/callback`;

  let shortLived;
  try {
    shortLived = await exchangeThreadsCode({ code, redirectUri });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Threads token exchange failed.",
    );
  }

  let longLived;
  try {
    longLived = await exchangeForLongLivedThreadsToken({
      shortLivedToken: shortLived.accessToken,
    });
  } catch (err) {
    return backWithError(
      err instanceof Error
        ? err.message
        : "Threads long-lived token swap failed.",
    );
  }

  let me;
  try {
    me = await getThreadsMe({ accessToken: longLived.accessToken });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Could not read Threads profile.",
    );
  }

  const { error: upsertErr } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "threads",
        auth_mode: "oauth",
        handle: `@${me.username}`,
        external_id: shortLived.userId,
        enc_access_token: encryptSecret(longLived.accessToken),
        token_expires_at: longLived.expiresAt.toISOString(),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    );
  if (upsertErr) {
    return backWithError(`Could not save account: ${upsertErr.message}`);
  }

  const ok = new URL("/dashboard/social/setup", env.siteUrl);
  ok.searchParams.set("connected", "threads");
  const res = NextResponse.redirect(ok);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
