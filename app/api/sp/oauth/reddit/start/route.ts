// Reddit OAuth — step 1: start.
// Generates a CSRF nonce, drops it in an httpOnly+sameSite=lax cookie,
// then 302s the user to reddit.com/api/v1/authorize. The callback route
// verifies the cookie matches Reddit's echoed `state`.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getRedditAuthorizeUrl } from "@/lib/sp/platforms/reddit";

const STATE_COOKIE = "sp_reddit_state";
const STATE_TTL_S = 600;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", env.siteUrl));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const redirectUri = `${env.siteUrl}/api/sp/oauth/reddit/callback`;
  const authorizeUrl = getRedditAuthorizeUrl({ state, redirectUri });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/sp/oauth/reddit",
    maxAge: STATE_TTL_S,
  });
  return res;
}
