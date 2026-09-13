// The OpenAffiliate descriptor: the program CrawlProof runs, in its own words.
// Spec: https://logicsrc.com/docs/openaffiliate
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ourDescriptorJson } from "@/lib/affiliate/program";

export const dynamic = "force-static";
export const revalidate = 3600;

// `updated` is the date the terms last changed, by hand: it tells a directory
// whether to re-read the rest, so a build stamp would defeat it.
const TERMS_UPDATED = "2026-09-13T00:00:00Z";

export function GET() {
  return NextResponse.json(ourDescriptorJson(env.siteUrl, TERMS_UPDATED), {
    headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" },
  });
}
