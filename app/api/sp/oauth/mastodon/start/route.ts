// Mastodon OAuth — step 1: start.
//
// Posted to as a form (instance URL is user input). For each new instance
// we register a Crawlproof app via POST /api/v1/apps and cache the
// client_id + AES-GCM-encrypted client_secret in sp_mastodon_app. Then
// we set a CSRF cookie carrying both the state nonce and the instance
// URL (the callback needs to know which instance to talk to), and 302
// the user to the instance's /oauth/authorize.

import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/sp/vault";
import {
  registerMastodonApp,
  getMastodonAuthorizeUrl,
  normalizeMastodonInstance,
} from "@/lib/sp/platforms/mastodon";

const STATE_COOKIE = "sp_mastodon_state";
const STATE_TTL_S = 600;

function backWithError(message: string): NextResponse {
  const u = new URL("/social/setup", env.siteUrl);
  u.searchParams.set("error", message);
  return NextResponse.redirect(u);
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", env.siteUrl));
  }

  const form = await req.formData();
  const rawInstance = String(form.get("instance_url") ?? "");
  let instanceUrl: string;
  try {
    instanceUrl = normalizeMastodonInstance(rawInstance);
  } catch (err) {
    return backWithError(
      err instanceof Error ? err.message : "Bad Mastodon instance URL.",
    );
  }

  const redirectUri = `${env.siteUrl}/api/sp/oauth/mastodon/callback`;
  const service = serviceClient();

  // Cache lookup. sp_mastodon_app is service-role only — anon/auth RLS
  // denies everything.
  const { data: cached } = await service
    .from("sp_mastodon_app")
    .select("client_id, enc_client_secret, redirect_uri")
    .eq("instance_url", instanceUrl)
    .maybeSingle();

  let clientId: string;
  if (cached) {
    clientId = cached.client_id as string;
    // Sanity check: if redirect_uri changed (e.g. NEXT_PUBLIC_SITE_URL
    // moved), re-register so the cached client matches our callback.
    if (cached.redirect_uri !== redirectUri) {
      try {
        const app = await registerMastodonApp({ instanceUrl, redirectUri });
        await service
          .from("sp_mastodon_app")
          .update({
            client_id: app.clientId,
            enc_client_secret: encryptSecret(app.clientSecret),
            redirect_uri: app.redirectUri,
          })
          .eq("instance_url", instanceUrl);
        clientId = app.clientId;
      } catch (err) {
        return backWithError(
          err instanceof Error ? err.message : "Mastodon app registration failed.",
        );
      }
    }
  } else {
    try {
      const app = await registerMastodonApp({ instanceUrl, redirectUri });
      const { error: insErr } = await service
        .from("sp_mastodon_app")
        .insert({
          instance_url: instanceUrl,
          client_id: app.clientId,
          enc_client_secret: encryptSecret(app.clientSecret),
          redirect_uri: app.redirectUri,
        });
      if (insErr) {
        return backWithError(`Could not cache Mastodon app: ${insErr.message}`);
      }
      clientId = app.clientId;
    } catch (err) {
      return backWithError(
        err instanceof Error ? err.message : "Mastodon app registration failed.",
      );
    }
  }
  const state = crypto.randomBytes(24).toString("base64url");
  const cookieValue = Buffer.from(
    JSON.stringify({ s: state, i: instanceUrl }),
  ).toString("base64url");

  const authorizeUrl = getMastodonAuthorizeUrl({
    instanceUrl,
    clientId,
    redirectUri,
    state,
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: env.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/sp/oauth/mastodon",
    maxAge: STATE_TTL_S,
  });
  return res;
}
