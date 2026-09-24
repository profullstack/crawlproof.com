// Public streaming-break endpoint.
//
// A player asks for something to play in an ad break; this answers with one
// media URL, or with nothing. Nothing is a perfectly good answer and is what
// every failure returns: a break that cannot be filled simply does not happen
// and the listener keeps their content, which is the only behaviour that is
// safe to default to when the alternative is dead air.
//
// Selection, the auction and the impression are serveAd's, exactly as they are
// for a banner. A second selection path would be a second set of numbers, and
// the one not wired to billing is the one that quietly gives inventory away.
// This route only turns the creative serveAd chose into a file to fetch.

import { NextRequest, NextResponse } from "next/server";
import { serveAd } from "@/lib/ads/serve";
import { serviceClient } from "@/lib/supabase/service";
import { streamMediaFor, type StreamKind } from "@/lib/ads/video/serve";
import { VIDEO_FORMAT_ID } from "@/lib/ads/formats";
import { ASSET_BUCKET } from "@/lib/ads/video/storage";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { parseDevice } from "@/lib/tracker/device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Never cached: every fill is metered, and a cached one is an impression
    // that happened without being counted.
    "cache-control": "no-store",
    vary: "Origin",
  };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

/** An unfilled break. 200, not 404: there is no error here, just no advert. */
function empty(headers: Record<string, string>) {
  return NextResponse.json({ url: null }, { headers });
}

export async function GET(request: NextRequest) {
  const headers = cors(request);

  try {
    const url = new URL(request.url);
    const slotId = url.searchParams.get("slot");
    const kindParam = url.searchParams.get("kind");
    // Audio by default. The properties most likely to call this are music and
    // radio players, and handing a <video> URL to something with nowhere to
    // show it is worse than handing it audio it can definitely play.
    const kind: StreamKind = kindParam === "video" ? "video" : "audio";

    if (!slotId) return empty(headers);

    const ip = clientIpFromHeaders(request.headers);
    const geo = await lookupGeo(ip).catch(() => null);
    const fill = await serveAd(slotId, VIDEO_FORMAT_ID, {
      ip,
      country: geo?.countryCode ?? null,
      device: parseDevice(request.headers.get("user-agent")).deviceType,
    });
    if (!fill) return empty(headers);

    const sb = serviceClient();
    const media = await streamMediaFor(sb, {
      creativeId: fill.creativeId,
      kind,
      publicUrlFor: (key) => sb.storage.from(ASSET_BUCKET).getPublicUrl(key).data.publicUrl,
    });

    // Chosen, metered, but the media is not there. Returning an empty break is
    // right — there is nothing to play — but it is worth being loud about,
    // because it means a campaign is winning auctions it cannot fill.
    if (!media) {
      console.warn(
        `[ads] stream break unfilled: creative ${fill.creativeId} has no published ${kind} media`,
      );
      return empty(headers);
    }

    return NextResponse.json(
      {
        url: media.url,
        kind: media.kind,
        durationMs: media.durationMs,
        posterUrl: media.posterUrl,
        captionsUrl: media.captionsUrl,
        // The player opens this when the listener interacts with the break.
        clickUrl: fill.clickUrl,
        impressionId: fill.impressionId,
      },
      { headers },
    );
  } catch {
    // Same rule as the banner tag: a failure here must never be visible to the
    // person listening.
    return empty(headers);
  }
}
