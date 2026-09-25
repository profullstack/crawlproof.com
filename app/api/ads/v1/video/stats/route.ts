// /api/ads/v1/video/stats — the pre-roll funnel for a bearer-token caller.
//
//   GET ?days=7&side=campaigns|slots|both
//
// Same auth as /api/ads/v1/campaigns. This is what `crawlproof ads video`
// calls.
//
// Both sides are returned by default because the two answer different
// questions and the interesting case is when they disagree: campaigns with
// fills and no starts means the ad is being chosen and never played, while
// slots with fills and no starts means the publisher's player is not
// reporting at all.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import {
  parseDays,
  videoFunnelForOwner,
  videoSlotFunnelForOwner,
} from "@/lib/ads/video/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const days = parseDays(url.searchParams.get("days"));
  const side = (url.searchParams.get("side") || "both").toLowerCase();

  const sb = serviceClient();
  const [campaigns, slots] = await Promise.all([
    side === "slots" ? Promise.resolve([]) : videoFunnelForOwner(sb, auth.userId, days),
    side === "campaigns" ? Promise.resolve([]) : videoSlotFunnelForOwner(sb, auth.userId, days),
  ]);

  return NextResponse.json({ days, campaigns, slots });
}
