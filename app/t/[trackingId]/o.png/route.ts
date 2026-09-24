// Email open pixel: GET /t/<trackingId>/o.png?m=<msgId>&c=<campaign>&v=<variant>
//
// Always 200 with the same transparent PNG and no-cache headers, whatever the
// id turns out to be and whether tracking is on. A 404 would let anyone probe
// ids, and a broken image in somebody's inbox is worse than a lost datapoint.
// Recording happens before the response: there is no retry for an image load.

import { NextResponse } from "next/server";
import {
  PIXEL_HEADERS,
  PIXEL_PNG,
  clientIp,
  isLikelyMachineOpen,
  isPlausibleTrackingId,
  tag,
} from "@/lib/emailTracking/core";
import { findByTrackingId, firstSighting, insertEvent } from "@/lib/emailTracking/store";
import { hashIpRotating } from "@/lib/ipHash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pixel(): NextResponse {
  return new NextResponse(new Uint8Array(PIXEL_PNG), { status: 200, headers: PIXEL_HEADERS });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  try {
    const { trackingId } = await params;
    if (!isPlausibleTrackingId(trackingId)) return pixel();
    const row = await findByTrackingId(trackingId);
    if (!row || !row.enabled) return pixel();

    const q = new URL(req.url).searchParams;
    const m = tag(q.get("m"));
    const now = new Date();
    const ua = req.headers.get("user-agent");
    const firstSeenAt = m ? await firstSighting(row.project_id, m) : null;

    await insertEvent({
      project_id: row.project_id,
      type: "open",
      m,
      c: tag(q.get("c")),
      v: tag(q.get("v")),
      machine: isLikelyMachineOpen({ userAgent: ua, firstSeenAt, now }),
      visitor_hash: hashIpRotating(clientIp(req.headers), now),
    });
  } catch {
    // A failure to record is never a reason to break the email.
  }
  return pixel();
}

// Some clients HEAD an image before fetching it. Same answer, no body, no record.
export function HEAD() {
  return new NextResponse(null, { status: 200, headers: PIXEL_HEADERS });
}
