// Playback beacons for a pre-roll.
//
//   POST { decision, events: [{ type, mediaTimeMs, playedMs, ts, id? }] }
//
// Open to any origin and unauthenticated, exactly like /api/track and the ad
// click redirect: the caller is a media element on a publisher's page, and
// there is no credential a browser could hold that a page could not read.
// What keeps it honest is the decision id — it is a server-minted uuid the
// caller can only have received by being handed an ad, the progress events
// dedupe in the database, and none of this touches billing. The worst a forged
// beacon can do is claim an ad that was served was also watched.
//
// The body may arrive as `navigator.sendBeacon` sends it — text/plain, or a
// Blob with no content type at all, during page teardown — so the content type
// is not checked. The text is parsed as JSON and that is the whole contract.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { parseEventBatch, recordVideoEvents } from "@/lib/ads/video/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
    vary: "Origin",
  };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

export async function POST(request: NextRequest) {
  const headers = cors(request);

  let body: unknown;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400, headers });
  }

  const parsed = parseEventBatch(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers });
  }

  try {
    const result = await recordVideoEvents(serviceClient(), parsed);
    // 202, not 200: a duplicate beacon is accepted and written nowhere, and
    // the counts say which happened without making either an error.
    return NextResponse.json(result, { status: 202, headers });
  } catch {
    // A measurement we failed to store is not the player's problem, and a 500
    // here would make a retry loop out of a page that is already unloading.
    return NextResponse.json({ accepted: 0, duplicates: 0 }, { status: 202, headers });
  }
}
