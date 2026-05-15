// X (Twitter) OAuth — step 1: start.
// PKCE confidential client: nonce + code_verifier in the state cookie,
// challenge in the authorize URL.

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { generatePkcePair } from "@/lib/sp/pkce";
import { getXAuthorizeUrl } from "@/lib/sp/platforms/x";

const STATE_COOKIE = "sp_x_state";
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
  const pkce = generatePkcePair();
  const redirectUri = `${env.siteUrl}/api/sp/oauth/x/callback`;
  const authorizeUrl = getXAuthorizeUrl({
    state,
    codeChallenge: pkce.challenge,
    redirectUri,
  });

  // Cookie carries both nonce (CSRF) and PKCE verifier (the callback
  // can't reconstruct the verifier from anything else).
  const cookieValue = Buffer.from(
    JSON.stringify({ s: state, v: pkce.verifier }),
  ).toString("base64url");

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: env.siteUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/api/sp/oauth/x",
    maxAge: STATE_TTL_S,
  });
  return res;
}
