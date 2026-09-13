// Ad click redirector. The rendered creative links here; we record the click
// and 302 to the advertiser's destination with ?ref= applied. On any failure we
// still redirect somewhere safe rather than dead-ending the user.

import { NextRequest, NextResponse } from "next/server";
import { resolveClick } from "@/lib/ads/serve";
import { lookupGeo } from "@/lib/tracker/geo";
import { adClickIp } from "@/lib/ads/client-ip";
import { parseDevice } from "@/lib/tracker/device";
import { env } from "@/lib/env";
import { gate } from "@/lib/crawl-gateway";
import { crawlerFamily } from "@/lib/crawl-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await gate(request);
  if (denied) return denied;
  const fallback = env.siteUrl || "https://crawlproof.com";
  try {
    const url = new URL(request.url);
    const impressionId = url.searchParams.get("i");
    const slotId = url.searchParams.get("s");
    const campaignId = url.searchParams.get("c");
    const creativeId = url.searchParams.get("cr");
    const visitorId = url.searchParams.get("v");

    const ip = adClickIp(request.headers);
    const crawler = crawlerFamily(request.headers.get("user-agent"));
    const geo = crawler ? null : await lookupGeo(ip).catch(() => null);
    const device = crawler ? "bot" : parseDevice(request.headers.get("user-agent")).deviceType;

    const dest = await resolveClick({
      impressionId,
      slotId,
      campaignId,
      creativeId,
      ctx: { visitorId, ip, country: geo?.countryCode ?? null, device },
    });

    return NextResponse.redirect(dest ?? fallback, { status: 302 });
  } catch {
    return NextResponse.redirect(fallback, { status: 302 });
  }
}
