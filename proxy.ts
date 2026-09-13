import { gate } from "@/lib/crawl-gateway";
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { trackReferralCode } from "@profullstack/stack/referrals";
import { isNavigation } from "@/lib/affiliate/cookie";

type Cookie = { name: string; value: string; options?: CookieOptions };

export async function proxy(request: NextRequest) {
  // Crawl gateway first: AI training crawlers get 402 Payment Required (or the
  // sales page at /crawl) unless they present a paid pass. People, Googlebot
  // and retrieval crawlers fall through to everything below.
  const answer = await gate(request);
  if (answer) return answer;

  // 308 redirect www.crawlproof.com -> crawlproof.com (preserves method + body).
  const host = request.headers.get("host") ?? "";
  if (host.toLowerCase().startsWith("www.")) {
    const target = request.nextUrl.clone();
    target.host = host.slice(4);
    target.protocol = "https";
    target.port = "";
    return NextResponse.redirect(target, 308);
  }

  // OpenAffiliate: a navigation that carries ?oa=<code> goes through the click
  // route, which records the click, sets the attribution cookie and comes back
  // to the same path without the parameter. Only a navigation: an image, a
  // frame, a script or a prefetch carrying the parameter sets nothing, which
  // is the whole defence against cookie stuffing. The click route itself and
  // the API are excluded so the redirect cannot loop.
  {
    const oa = request.nextUrl.searchParams.get("oa");
    const p = request.nextUrl.pathname;
    if (oa && !p.startsWith("/api/") && !p.startsWith("/_next/") && isNavigation(request.headers)) {
      const clean = request.nextUrl.clone();
      clean.searchParams.delete("oa");
      const click = request.nextUrl.clone();
      click.pathname = "/api/affiliate/v1/click";
      click.search = "";
      click.searchParams.set("oa", oa.toLowerCase());
      click.searchParams.set("to", `${clean.pathname}${clean.search}`);
      return NextResponse.redirect(click, 302);
    }
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
