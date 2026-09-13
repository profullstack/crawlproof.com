// GET /api/affiliate/v1/click?oa=<code>&to=<path> — the landing for a
// navigation that carried ?oa=. The middleware sends every such navigation
// here; this records the click, sets the attribution cookie, and redirects
// to the same path with the parameter stripped (spec, "Links and
// attribution" rule 2). An unknown code still lands the visitor on the page.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME, encodeCookie } from "@/lib/affiliate/cookie";
import { recordClick } from "@/lib/affiliate/attribution";
import { membershipByCode } from "@/lib/affiliate/memberships";
import { WINDOW_DAYS } from "@/lib/affiliate/program";
import { isAffiliateCode } from "@/lib/affiliate/spec";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safePath(to: string | null): string {
  if (!to || !to.startsWith("/") || to.startsWith("//")) return "/";
  return to;
}

export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get("oa") ?? "").toLowerCase();
  const to = safePath(req.nextUrl.searchParams.get("to"));
  const dest = new URL(to, env.siteUrl);
  const res = NextResponse.redirect(dest, 302);
  res.headers.set("cache-control", "no-store");

  if (!isAffiliateCode(code)) return res;
  try {
    const membership = await membershipByCode(code);
    if (!membership || membership.status !== "active") return res;
    const clickedAt = new Date();
    res.cookies.set(COOKIE_NAME, encodeCookie({ code: membership.code, clickedAt }), {
      path: "/",
      maxAge: WINDOW_DAYS * 86_400,
      sameSite: "lax",
      httpOnly: true,
      secure: env.siteUrl.startsWith("https://"),
    });
    const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
    await recordClick({
      membership,
      landing: to,
      referrer: req.headers.get("referer"),
      ip,
      userAgent: req.headers.get("user-agent"),
    });
  } catch (err) {
    console.error("[affiliate] click", err);
  }
  return res;
}
