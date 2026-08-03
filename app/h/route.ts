// Short house-ad click redirector: https://crawlproof.com/h
//
// The terminal twin of /a/<impression_id>, for house ads. House fills are
// unmetered and have no impression row, so there is nothing to look up — this
// exists purely to keep the printed URL short.
//
// Why it has to be short: a terminal ad prints its click URL as literal text
// inside the ASCII box, and the box is only `cols` wide. At the narrowest
// supported width (44 cols) there are 40 columns of usable room, and the old
// house URL —
//
//   https://crawlproof.com/?utm_source=house-ad&utm_medium=motd   (59 chars,
//   plus the publisher's &s=<surface> tag, so 66 in practice)
//
// — could not fit, so renderCreativeText was forced to print it below the
// frame, dangling well past the right edge of a box the caller had explicitly
// asked to be 44 wide. `/h` is 24 characters, or 31 with a surface tag, which
// fits inside the box at every supported width.
//
// The utm params the old URL carried inline are re-applied here instead, so
// attribution is unchanged — it just happens server-side, where characters are
// free.

import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const base = env.siteUrl || "https://crawlproof.com";
  try {
    // ?s=<surface> is the publisher's own tag (bbs, ssh-banner, motd, …),
    // carried through from /api/ads/motd. Sanitised the same way it is there:
    // it arrives from a query string and goes back out in a redirect.
    const q = new URL(request.url).searchParams;
    const src = (q.get("s") ?? q.get("src") ?? "").trim().replace(/[^\w.-]/g, "").slice(0, 32);

    const dest = new URL(base);
    dest.searchParams.set("utm_source", "house-ad");
    // "terminal" rather than the old "motd": the surface is what ?s= records,
    // and this same URL is printed into BBS screens and SSH banners too.
    dest.searchParams.set("utm_medium", "terminal");
    if (src) dest.searchParams.set("utm_content", src);
    return NextResponse.redirect(dest.toString(), { status: 302 });
  } catch {
    return NextResponse.redirect(base, { status: 302 });
  }
}
