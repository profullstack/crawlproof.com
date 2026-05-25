// Facebook OAuth — step 2: callback.
//
// After the user grants permission, we exchange the code for a user
// access token, then call /me/accounts to enumerate the Pages they
// manage. For each Page we create a separate sp_account row keyed on
// the Page id — each Page has its own long-lived Page access token,
// which is what we actually post with.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";
import {
  exchangeFacebookCode,
  listFacebookPages,
} from "@/lib/sp/platforms/facebook";

const STATE_COOKIE = "sp_facebook_state";

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
  if (!user) return NextResponse.redirect(new URL("/login", env.siteUrl));

  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const platformError = params.get("error");
  const cookieState = req.cookies.get(STATE_COOKIE)?.value;

  if (platformError) return backWithError(`Facebook declined: ${platformError}`);
  if (!code || !state) return backWithError("Facebook returned no code.");
  if (!cookieState || cookieState !== state) {
    return backWithError("OAuth state mismatch. Try again.");
  }

  const redirectUri = `${env.siteUrl}/api/sp/oauth/facebook/callback`;

  let userToken;
  try {
    userToken = await exchangeFacebookCode({ code, redirectUri });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Facebook token exchange failed.",
    );
  }

  let pages;
  try {
    pages = await listFacebookPages({ userAccessToken: userToken.accessToken });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Could not list Facebook Pages.",
    );
  }

  if (pages.length === 0) {
    return backWithError(
      "No Facebook Pages found on your account. Create or admin a Page first.",
    );
  }

  // One sp_account per Page. Idempotent on (user_id, platform=facebook_page,
  // external_id=page_id).
  const rows = pages.map((p) => ({
    user_id: user.id,
    platform: "facebook_page",
    auth_mode: "oauth",
    handle: p.name,
    external_id: p.id,
    enc_access_token: encryptSecret(p.accessToken),
    status: "active" as const,
  }));
  const { error: upsertErr } = await supabase
    .from("sp_account")
    .upsert(rows, { onConflict: "user_id,platform,external_id" });
  if (upsertErr) {
    return backWithError(`Could not save Pages: ${upsertErr.message}`);
  }

  const ok = new URL("/social/setup", env.siteUrl);
  ok.searchParams.set("connected", `facebook (${pages.length} page${pages.length === 1 ? "" : "s"})`);
  const res = NextResponse.redirect(ok);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
