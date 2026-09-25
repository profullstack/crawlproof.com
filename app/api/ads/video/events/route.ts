// Playback beacons for a video ad.
//
//   POST { decision, events: [{ type, mediaTimeMs, playedMs, ts, id? }] }
//   GET  ?d=<decision>&t=<type>&m=<mediaMs>&p=<playedMs>  -> a 1x1 gif
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
//
// The GET form exists for one reason: an ad unit rendered inside a publisher's
// page is governed by the PUBLISHER's Content-Security-Policy, and a `fetch` to
// us needs a `connect-src` entry they have not granted and should not have to.
// An image request is governed by `img-src`, which a unit carrying advertiser
// artwork already requires, so the pixel measures where the POST would be
// silently blocked. It carries one event; that is the whole difference.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { parseEventBatch, recordVideoEvents } from "@/lib/ads/video/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

/**
 * A 1x1 transparent gif, answered whatever happens.
 *
 * The caller is an `<img>` inside somebody's ad unit and has nothing useful to
 * do with an error — a broken-image icon in a publisher's banner is a worse
 * outcome than a measurement we quietly dropped.
 */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function pixel(headers: Record<string, string>) {
  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      ...headers,
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
    },
  });
}

/** The pixel form: one event per image request. */
export async function GET(request: NextRequest) {
  const headers = cors(request);
  const url = new URL(request.url);

  const num = (v: string | null) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };

  const parsed = parseEventBatch({
    decision: url.searchParams.get("d"),
    events: [
      {
        type: url.searchParams.get("t"),
        id: url.searchParams.get("i") ?? undefined,
        mediaTimeMs: num(url.searchParams.get("m")),
        playedMs: num(url.searchParams.get("p")),
        source: url.searchParams.get("s") ?? "media_element",
        errorReason: url.searchParams.get("e") ?? undefined,
      },
    ],
  });
  if ("error" in parsed) return pixel(headers);

  try {
    await recordVideoEvents(serviceClient(), parsed);
  } catch {
    // Same rule as the POST: a measurement we failed to store is not the
    // reader's problem, and it must never show up in their page.
  }
  return pixel(headers);
}
