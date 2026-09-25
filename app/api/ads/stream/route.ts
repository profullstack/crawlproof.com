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
//
// It also opens the measurement: the response carries a `decisionId` the
// player reports playback against (/api/ads/video/events). That id is the only
// thing that distinguishes an ad that was chosen from one that was watched,
// and without it a five-second video reports exactly what a banner reports.

import { NextRequest, NextResponse } from "next/server";
import { serveAd } from "@/lib/ads/serve";
import { serviceClient } from "@/lib/supabase/service";
import { streamMediaFor, type StreamKind } from "@/lib/ads/video/serve";
import {
  existingDecision,
  normalizePlacement,
  normalizeSurface,
  recordDecision,
} from "@/lib/ads/video/decisions";
import { VIDEO_FORMAT_ID } from "@/lib/ads/formats";
import { ASSET_BUCKET } from "@/lib/ads/video/storage";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { parseDevice } from "@/lib/tracker/device";
import { env } from "@/lib/env";

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

const eventsUrl = () => `${(env.siteUrl || "https://crawlproof.com").replace(/\/$/, "")}/api/ads/video/events`;

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
    const placement = normalizePlacement(url.searchParams.get("placement"));
    const surface = normalizeSurface(url.searchParams.get("surface"));

    if (!slotId) return empty(headers);

    const sb = serviceClient();
    const publicUrlFor = (key: string) => sb.storage.from(ASSET_BUCKET).getPublicUrl(key).data.publicUrl;

    // The player's own id for this listen. Minted here when it does not send
    // one, which keeps every existing caller working — but a session id it
    // does not supply is a session we cannot recognise on a retry, so the
    // helper in /preroll.js always sends one.
    const sentSession = (url.searchParams.get("session") || "").trim().slice(0, 100);
    const sessionId = sentSession || crypto.randomUUID();

    // Already answered for this session: return the same ad, unmetered.
    // Selection and metering are skipped entirely — a remount is not a second
    // opportunity to show an ad, and charging for it would be charging twice
    // for one play.
    if (sentSession) {
      const prior = await existingDecision(sb, { slotId, sessionId, placement });
      if (prior) {
        if (prior.result === "no_ad") return empty(headers);
        const media = await streamMediaFor(sb, {
          creativeId: prior.creative_id ?? "house",
          kind,
          publicUrlFor,
        });
        if (!media) return empty(headers);
        return NextResponse.json(
          {
            url: media.url,
            kind: media.kind,
            durationMs: media.durationMs,
            posterUrl: media.posterUrl,
            captionsUrl: media.captionsUrl,
            clickUrl: prior.destination_url,
            impressionId: prior.impression_id,
            decisionId: prior.id,
            sessionId,
            eventsUrl: eventsUrl(),
            repeat: true,
          },
          { headers },
        );
      }
    }

    const ip = clientIpFromHeaders(request.headers);
    const geo = await lookupGeo(ip).catch(() => null);
    const fill = await serveAd(slotId, VIDEO_FORMAT_ID, {
      // The one path allowed past fitAdFormat's refusal of streaming formats.
      // It also suppresses markup rendering, so this cannot become a way to
      // draw a video creative as a banner.
      streaming: true,
      ip,
      country: geo?.countryCode ?? null,
      device: parseDevice(request.headers.get("user-agent")).deviceType,
    });

    // An empty break is still a decision, and recording it is the point: a
    // slot that asks a hundred times and fills nothing looks identical to a
    // slot nobody ever called unless the misses are written down too.
    if (!fill) {
      await recordDecision(sb, {
        slotId,
        sessionId,
        placement,
        kind,
        surface,
        fill: null,
        assetRevision: null,
        reason: "no_fill",
      });
      return empty(headers);
    }

    const media = await streamMediaFor(sb, { creativeId: fill.creativeId, kind, publicUrlFor });

    // Chosen, metered, but the media is not there. Returning an empty break is
    // right — there is nothing to play — but it is worth being loud about,
    // because it means a campaign is winning auctions it cannot fill.
    if (!media) {
      console.warn(
        `[ads] stream break unfilled: creative ${fill.creativeId} has no published ${kind} media`,
      );
      await recordDecision(sb, {
        slotId,
        sessionId,
        placement,
        kind,
        surface,
        fill: null,
        assetRevision: null,
        reason: "no_media",
      });
      return empty(headers);
    }

    const decisionId = await recordDecision(sb, {
      slotId,
      sessionId,
      placement,
      kind,
      surface,
      fill,
      assetRevision: media.revision,
    });

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
        // Null when the decision could not be written. A player treats that as
        // "play it, report nothing" rather than as an error.
        decisionId,
        sessionId,
        eventsUrl: eventsUrl(),
      },
      { headers },
    );
  } catch {
    // Same rule as the banner tag: a failure here must never be visible to the
    // person listening.
    return empty(headers);
  }
}
