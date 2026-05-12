import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

// Resolve the URL Supabase should send users back to. Inside the Railway
// container Next.js's `request.url` carries the bind address (e.g.
// http://0.0.0.0:8080) — never use that for redirects. Prefer:
//   1. NEXT_PUBLIC_SITE_URL (canonical public URL)
//   2. x-forwarded-host (Railway proxy)
//   3. Host header (last resort)
function publicOrigin(request: Request): string {
  if (env.siteUrl) return env.siteUrl.replace(/\/$/, "");
  const xfHost = request.headers.get("x-forwarded-host");
  const xfProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (xfHost) return `${xfProto}://${xfHost}`;
  const host = request.headers.get("host");
  if (host) return `${xfProto}://${host}`;
  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";
  const origin = publicOrigin(request);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const redirectUrl = new URL("/login", origin);
      redirectUrl.searchParams.set("error", error.message);
      return NextResponse.redirect(redirectUrl);
    }
  }

  return NextResponse.redirect(new URL(next, origin));
}
