import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { attributeUser } from "@/lib/affiliate/attribution";
import { cookieFromHeader } from "@/lib/affiliate/cookie";
import { INVITE_COOKIE, onSignedIn } from "@/lib/creditCodes";
import { serviceClient } from "@/lib/supabase/service";
import { funnelContext, recordFunnelEvent } from "@/lib/funnel";

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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // OpenAffiliate: bind the signed-in user to the affiliate in their cookie.
    try {
      const oa = cookieFromHeader(request.headers.get("cookie"));
      if (oa && user) await attributeUser(user.id, oa);
    } catch (err) {
      console.error("[affiliate] attribute at sign-in", err);
    }
    // Funnel (R6): this is the email-confirmation landing, so a just-created
    // account's first pass through here is its signup.
    if (user) await recordSignupIfNew(user, request.headers.get("cookie"));
    // Invites: this is also the email-confirmation landing, so accept a pending
    // invite (cookie, or the code saved at signup) and pay any bonus now due.
    if (user) {
      const invite =
        readCookie(request.headers.get("cookie"), INVITE_COOKIE) ??
        (typeof user.user_metadata?.invite_code === "string" ? user.user_metadata.invite_code : null);
      await onSignedIn(user.id, invite);
      if (invite) {
        const res = NextResponse.redirect(new URL(next, origin));
        res.cookies.set(INVITE_COOKIE, "", { maxAge: 0, path: "/" });
        return res;
      }
    }
  }

  return NextResponse.redirect(new URL(next, origin));
}

const SIGNUP_WINDOW_MS = 30 * 60 * 1000;

async function recordSignupIfNew(
  user: { id: string; created_at?: string },
  cookieHeader: string | null,
): Promise<void> {
  try {
    const created = user.created_at ? Date.parse(user.created_at) : NaN;
    if (!Number.isFinite(created) || Date.now() - created > SIGNUP_WINDOW_MS) return;
    const { count } = await serviceClient()
      .from("funnel_events")
      .select("id", { count: "exact", head: true })
      .eq("event", "signup")
      .eq("user_id", user.id);
    if ((count ?? 0) > 0) return;
    const ctx = funnelContext(cookieHeader);
    await recordFunnelEvent({ event: "signup", source: ctx.source, visitorId: ctx.visitorId, userId: user.id });
  } catch (err) {
    console.warn("[funnel] signup record failed", err);
  }
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      const v = decodeURIComponent(part.slice(i + 1).trim());
      return v || null;
    }
  }
  return null;
}
