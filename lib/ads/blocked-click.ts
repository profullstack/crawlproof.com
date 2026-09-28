// What a refused click gets back (see BLOCKED_CLICK in ./serve).
//
// 410 rather than a redirect to the homepage: a redirect is a reward, and the
// harvesting crawler would simply follow it and crawl us instead. The body
// carries no link to the advertiser for the same reason. noindex/nofollow and
// no-store so nothing between us and it keeps the answer or the URL.

import { NextResponse } from "next/server";

export function blockedClickResponse(): NextResponse {
  return new NextResponse(
    "<!doctype html><meta charset=utf-8><title>Link expired</title><p>This ad link has expired.</p>",
    {
      status: 410,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}
