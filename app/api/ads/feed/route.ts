// Feed ad fill — a creative as a syndication item.
//
//   curl -s "https://crawlproof.com/api/ads/feed?slot=<slot_id>"
//   curl -s "https://crawlproof.com/api/ads/feed?slot=<slot_id>&as=atom"
//   curl -s "https://crawlproof.com/api/ads/feed?slot=<slot_id>&as=fields&n=3"
//
// Meant to be called by whatever builds a feed — a static site generator, a
// CMS, a cron job, an aggregator like rssamplifier.com — and the result pasted
// into the document being built. Nothing here renders in a browser and nothing
// here is embedded: like /api/ads/motd, this is fetched.
//
// Parameters, all optional:
//
//   slot   the publisher placement being filled; impressions and click earnings
//          are credited to it. Omitted falls back to ADS_DEFAULT_SLOT_ID, so a
//          bare curl still rotates real campaigns.
//   as     wire shape: rss | atom | json | html | markdown | text | fields.
//          Default rss. See lib/ads/feeditem for what each one is for.
//   style  body style: text | card | terminal | article. Default text — the long
//          thin one. `article` renders the campaign's editorial summary as real
//          paragraphs, for an ad that lives inside a blog post; it falls back to
//          `card` for campaigns with no prose.
//   guid   identity rotation: daily | weekly | fill | static. Default daily.
//   n      how many ads to return, 1..5. Each is an independent fill with its
//          own impression and its own identity.
//   label  disclosure wording. Defaults to "Sponsored", and cannot be removed.
//   cols   box width for style=terminal.
//   src    publisher's surface tag, recorded on the impression.
//   v      visitor id, if the caller has one.
//
// Metering matches every other serving path: serveAd records the impression
// server-side, at fetch time. That is worth being explicit about, because a
// feed is fan-out — one fetch by a publisher's build produces one impression,
// and the document it lands in may then be read by thousands of subscribers.
// Feed impressions therefore undercount reach by design. Clicks are exact: they
// go through the ordinary redirector and are metered per click.

import { NextRequest, NextResponse } from "next/server";
import { campaignSummary, serveAd } from "@/lib/ads/serve";
import { houseFill } from "@/lib/ads/house";
import { FEED_FORMAT_ID } from "@/lib/ads/formats";
import {
  feedDeviceType,
  feedFields,
  isFeedShape,
  isFeedStyle,
  isGuidMode,
  jsonFeedItem,
  renderFeedAd,
  type FeedItemInput,
  type FeedRenderOpts,
  type FeedShape,
} from "@/lib/ads/feeditem";
import { clampCols } from "@/lib/ads/terminal";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { parseDevice } from "@/lib/tracker/device";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Most ads a single request will return, however many were asked for. */
const MAX_ADS = 5;

function headers(request: Request, contentType: string): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "content-type": contentType,
    // Every request is a fresh fill and a fresh impression, so nothing shared
    // may cache it. A publisher who wants to fetch less often should cache on
    // their side, where they can key it to their own build.
    "cache-control": "no-store",
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, OPTIONS",
    vary: "Origin",
    "x-robots-tag": "noindex",
  };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: headers(request, "text/plain; charset=utf-8"),
  });
}

/** Publisher's surface tag. Sanitised hard — it is recorded and re-emitted. */
function cleanSrc(v: string | null): string {
  return (v ?? "").trim().replace(/[^\w.-]/g, "").slice(0, 32);
}

/**
 * Put a query parameter on a URL, leaving it alone if it will not parse.
 *
 * Only used for the house ad's surface tag — see below.
 */
function withParam(rawUrl: string, key: string, value: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function clampCount(v: string | null): number {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_ADS, Math.max(1, n));
}

/**
 * The empty answer for a shape.
 *
 * A feed build is usually string concatenation, so the failure that costs a
 * publisher least is one that contributes nothing: an empty fragment splices
 * into a document invisibly, while an error page spliced into a `<channel>`
 * makes the whole feed unparseable for every subscriber. Status stays 200 for
 * the same reason — a build script checking `res.ok` should not abort the
 * publisher's deploy because our ad server had a bad minute.
 */
function emptyBody(shape: FeedShape): string {
  if (shape === "json") return "[]\n";
  if (shape === "fields") return `${JSON.stringify({ ok: false, count: 0, items: [] }, null, 2)}\n`;
  return "";
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const shape: FeedShape = isFeedShape(url.searchParams.get("as"))
    ? (url.searchParams.get("as") as FeedShape)
    : "rss";

  try {
    const slotId = url.searchParams.get("slot") || env.adsDefaultSlotId;
    const visitorId = url.searchParams.get("v");
    const src = cleanSrc(url.searchParams.get("src"));
    const count = clampCount(url.searchParams.get("n"));

    const styleParam = url.searchParams.get("style");
    const guidParam = url.searchParams.get("guid");
    const opts: FeedRenderOpts = {
      style: isFeedStyle(styleParam) ? styleParam : "text",
      guidMode: isGuidMode(guidParam) ? guidParam : "daily",
      label: url.searchParams.get("label") ?? undefined,
      cols: url.searchParams.has("cols")
        ? clampCols(url.searchParams.get("cols"))
        : undefined,
    };

    // Geo and device are resolved once and reused across the fills: they
    // describe the caller, and the caller does not change between ad one and
    // ad three of the same request.
    const ip = clientIpFromHeaders(request.headers);
    const geo = await lookupGeo(ip).catch(() => null);
    const ua = request.headers.get("user-agent");
    // Feed builders identify as HTTP libraries, which the generic tracker calls
    // a bot — and bots get the unmetered house ad. feedDeviceType keeps real
    // crawlers out while letting builders and readers through; anything it
    // cannot place falls back to ordinary parsing. Without this a feed slot
    // could never earn. Same trap, same fix as the terminal endpoint.
    const device = feedDeviceType(ua) ?? parseDevice(ua).deviceType;

    // Fills are sequential rather than concurrent on purpose: serveAd picks by
    // weighted lottery and writes an impression row per call, and firing them
    // in parallel against the same slot is how you get the same campaign three
    // times in one document.
    const inputs: FeedItemInput[] = [];
    for (let i = 0; i < count; i += 1) {
      let fill = null;
      if (slotId) {
        fill = await serveAd(slotId, FEED_FORMAT_ID, {
          visitorId,
          ip,
          country: geo?.countryCode ?? null,
          device,
          src: src || null,
        });
      }
      // No slot given, or the slot is inactive / has no feed inventory. A feed
      // is a document somebody already published, so a missing fill is better
      // filled by the house ad than left as a hole in their river.
      if (!fill) fill = houseFill(FEED_FORMAT_ID);

      // A paid fill already carries the publisher's surface tag on its
      // impression row, which /a/<code> reads back when it builds utm_content.
      // A house fill has no impression row, so its tag has to ride the URL —
      // /h re-applies it server-side. Same split as the MOTD endpoint.
      const isHouse = fill.campaignId === "house";
      const clickUrl = src && isHouse ? withParam(fill.clickUrl, "s", src) : fill.clickUrl;

      // Editorial prose, when the campaign has any that still describes where
      // it points. Its own query, deliberately not part of the serving join —
      // see campaignSummary. Best-effort: a null here just renders the short
      // creative body, which is what every campaign did before this existed.
      const summary = await campaignSummary(fill.campaignId);

      inputs.push({
        creative: fill.creative,
        clickUrl,
        summary,
        slotId: slotId || "default",
        impressionId: fill.impressionId,
        tier: fill.tier,
        position: i,
      });
    }

    // The JSON shapes are collections rather than concatenated documents, so
    // they are assembled here instead of joined as strings.
    if (shape === "json") {
      const items = inputs.map((input) => jsonFeedItem(input, opts));
      return new NextResponse(`${JSON.stringify(items, null, 2)}\n`, {
        status: 200,
        headers: headers(request, "application/json; charset=utf-8"),
      });
    }
    if (shape === "fields") {
      const items = inputs.map((input) => feedFields(input, opts));
      return new NextResponse(
        `${JSON.stringify({ ok: true, count: items.length, items }, null, 2)}\n`,
        { status: 200, headers: headers(request, "application/json; charset=utf-8") },
      );
    }

    const parts = inputs.map((input) => renderFeedAd(shape, input, opts));
    const contentType = parts[0]?.contentType ?? "text/plain; charset=utf-8";
    return new NextResponse(parts.map((p) => p.body).join(""), {
      status: 200,
      headers: headers(request, contentType),
    });
  } catch {
    // Never break somebody's feed build. See emptyBody.
    return new NextResponse(emptyBody(shape), {
      status: 200,
      headers: headers(request, shape === "json" || shape === "fields"
        ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8"),
    });
  }
}
