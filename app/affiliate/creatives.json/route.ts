// GET /affiliate/creatives.json — what an affiliate may use as given (spec,
// rule 10). The house ad artwork already in public/ads/house.
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const dynamic = "force-static";

export function GET() {
  const site = env.siteUrl.replace(/\/$/, "");
  return NextResponse.json(
    [
      { url: `${site}/logo.svg`, kind: "logo", alt: "CrawlProof" },
      { url: `${site}/banner.png`, kind: "banner", alt: "CrawlProof: see who is reading your site, and get paid for it" },
    ],
    { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } },
  );
}
