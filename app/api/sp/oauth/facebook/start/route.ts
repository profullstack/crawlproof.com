// Facebook OAuth — step 1: start.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getFacebookAuthorizeUrl } from "@/lib/sp/platforms/facebook";

const STATE_COOKIE = "sp_facebook_state";
const STATE_TTL_S = 600;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.siteUrl));

  const state = crypto.randomBytes(24).toString("base64url");
  const redirectUri = `${env.siteUrl}/api/sp/oauth/facebook/callback`;
  const authorizeUrl = getFacebookAuthorizeUrl({ state, redirectUri });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/sp/oauth/facebook",
    maxAge: STATE_TTL_S,
  });
  return res;
}
