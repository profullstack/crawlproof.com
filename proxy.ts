import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { trackReferralCode } from "@profullstack/referrals/next";

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
  const isApp =
    path.startsWith("/dashboard") ||
    path.startsWith("/projects") ||
    path.startsWith("/audits") ||
    path.startsWith("/settings");

  if (isApp && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  return trackReferralCode(request, response as any);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|skill.md|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
