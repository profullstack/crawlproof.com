// Threads OAuth — step 1: start.

import { hasSealFor } from "@/lib/sp/vault";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getThreadsAuthorizeUrl } from "@/lib/sp/platforms/threads";
import { requirePlatformEnv } from "@/lib/sp/require-env";

const STATE_COOKIE = "sp_threads_state";
const STATE_TTL_S = 600;

export async function GET() {
  const notConfigured = requirePlatformEnv("threads");
  if (notConfigured) return notConfigured;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", env.siteUrl));

  // Sealed keys: tokens are sealed to the user's own key, so a passphrase
  // must exist before we can store them.
  if (!(await hasSealFor(user.id))) {
    return NextResponse.redirect(new URL("/dashboard/keys?next=connect", env.siteUrl));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const redirectUri = `${env.siteUrl}/api/sp/oauth/threads/callback`;
  const authorizeUrl = getThreadsAuthorizeUrl({ state, redirectUri });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/sp/oauth/threads",
    maxAge: STATE_TTL_S,
  });
  return res;
}
