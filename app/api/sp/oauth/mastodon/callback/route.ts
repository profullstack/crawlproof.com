// Mastodon OAuth — step 2: callback.
//
// The instance redirects here with `code` + `state` after the user grants
// consent. We:
//   1. Decode the state cookie to recover the nonce + instance URL.
//   2. Verify the nonce matches what the instance echoed.
//   3. Look up the cached app creds in sp_mastodon_app (we registered
//      the app at /start time).
//   4. Exchange the code for an access_token at {instance}/oauth/token.
//   5. Fetch /api/v1/accounts/verify_credentials for handle + external id.
//   6. Upsert sp_account.
//
// Mastodon access tokens don't expire by default (only on user revoke),
// so we leave token_expires_at NULL and have no refresh leg.

import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { encryptSecret, decryptSecret } from "@/lib/sp/vault";
import {
  exchangeMastodonCode,
  getMastodonMe,
} from "@/lib/sp/platforms/mastodon";

const STATE_COOKIE = "sp_mastodon_state";

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
  const cookieRaw = req.cookies.get(STATE_COOKIE)?.value;

  if (platformError) {
    return backWithError(`Mastodon declined: ${platformError}`);
  }
  if (!code || !state || !cookieRaw) {
    return backWithError("Mastodon returned no authorization code.");
  }

  let cookieParsed: { s: string; i: string };
  try {
    cookieParsed = JSON.parse(
      Buffer.from(cookieRaw, "base64url").toString("utf8"),
    );
  } catch {
    return backWithError("Mastodon OAuth state cookie is malformed.");
  }
  if (cookieParsed.s !== state) {
    return backWithError("OAuth state mismatch. Try again.");
  }
  const instanceUrl = cookieParsed.i;
  if (!instanceUrl) {
    return backWithError("OAuth cookie missing instance URL.");
  }

  const service = serviceClient();
  const { data: appRow } = await service
    .from("sp_mastodon_app")
    .select("client_id, enc_client_secret, redirect_uri")
    .eq("instance_url", instanceUrl)
    .maybeSingle();
  if (!appRow) {
    return backWithError("Mastodon app credentials missing — re-connect.");
  }

  let clientSecret: string;
  try {
    clientSecret = decryptSecret(appRow.enc_client_secret as string);
  } catch (err) {
    return backWithError(
      "Cached Mastodon client_secret could not be decrypted: " +
        (err instanceof Error ? err.message : "?"),
    );
  }

  let tokens;
  try {
    tokens = await exchangeMastodonCode({
      instanceUrl,
      clientId: appRow.client_id as string,
      clientSecret,
      code,
      redirectUri: appRow.redirect_uri as string,
    });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Mastodon token exchange failed.",
    );
  }

  let me;
  try {
    me = await getMastodonMe({
      instanceUrl,
      accessToken: tokens.accessToken,
    });
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Could not read Mastodon profile.",
    );
  }

  // Display handle includes the instance for clarity (acme@mastodon.social).
  const host = new URL(instanceUrl).host;
  const displayHandle = `@${me.username}@${host}`;

  const { error: upsertErr } = await supabase
    .from("sp_account")
    .upsert(
      {
        user_id: user.id,
        platform: "mastodon",
        auth_mode: "oauth",
        handle: displayHandle,
        external_id: me.id,
        instance_url: instanceUrl,
        enc_access_token: encryptSecret(tokens.accessToken),
        status: "active",
      },
      { onConflict: "user_id,platform,external_id" },
    );
  if (upsertErr) {
    return backWithError(`Could not save account: ${upsertErr.message}`);
  }

  const ok = new URL("/social/setup", env.siteUrl);
  ok.searchParams.set("connected", "mastodon");
  const res = NextResponse.redirect(ok);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
