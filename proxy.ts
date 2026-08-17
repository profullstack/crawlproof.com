import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { trackReferralCode } from "@profullstack/stack/referrals";

type Cookie = { name: string; value: string; options?: CookieOptions };

export async function proxy(request: NextRequest) {
  // 308 redirect www.crawlproof.com -> crawlproof.com (preserves method + body).
  const host = request.headers.get("host") ?? "";
  if (host.toLowerCase().startsWith("www.")) {
    const target = request.nextUrl.clone();
    target.host = host.slice(4);
    target.protocol = "https";
    target.port = "";
    return NextResponse.redirect(target, 308);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookies: Cookie[]) {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookies.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getUser();
  const user = error ? null : data.user;

  const path = request.nextUrl.pathname;
  // Every signed-in resource lives under /dashboard, so that one prefix is the
  // whole gate. The old top-level paths (/projects, /audits, /settings, …) are
  // 307'd here by next.config redirects, which run BEFORE middleware — so a
  // signed-out visitor on an old bookmark lands on /dashboard/... and is
  // caught by this check anyway, with the redirect param pointing at the new
  // path rather than the dead one.
  const isApp = path.startsWith("/dashboard");

  if (isApp && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    // 302 (Found) — temporary redirect: the resource exists but the user must
    // authenticate first. Using an explicit status avoids relying on the
    // Next.js default and keeps caches from storing the redirect permanently.
    return NextResponse.redirect(url, 302);
  }

  return trackReferralCode(request, response as any);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|skill.md|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
