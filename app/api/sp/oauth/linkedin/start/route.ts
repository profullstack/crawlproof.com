// LinkedIn OAuth — step 1: start.
// Same shape as the Reddit /start route: random CSRF nonce → httpOnly
// cookie → 302 to LinkedIn /oauth/v2/authorization.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getLinkedinAuthorizeUrl } from "@/lib/sp/platforms/linkedin";
import { requirePlatformEnv } from "@/lib/sp/require-env";

const STATE_COOKIE = "sp_linkedin_state";
const STATE_TTL_S = 600;

export async function GET() {
  const notConfigured = requirePlatformEnv("linkedin");
  if (notConfigured) return notConfigured;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", env.siteUrl));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const redirectUri = `${env.siteUrl}/api/sp/oauth/linkedin/callback`;
  const authorizeUrl = getLinkedinAuthorizeUrl({ state, redirectUri });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/sp/oauth/linkedin",
    maxAge: STATE_TTL_S,
  });
  return res;
}
