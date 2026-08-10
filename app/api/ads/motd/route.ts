// Plain-text ad fill for terminals — the MOTD endpoint.
//
//   curl -s "https://crawlproof.com/api/ads/motd?slot=<slot_id>"
//   curl -s "https://crawlproof.com/api/ads/motd?slot=<slot_id>&cols=64&color=1"
//   curl -s "https://crawlproof.com/api/ads/motd?slot=<slot_id>&v=<visitor_id>"
//
// `v` is the visitor id. On the web, /ad.js mints and persists one in
// localStorage; a terminal has neither cookies nor localStorage, so the caller
// has to supply it or every fetch counts as a new person — which is exactly why
// a scheduled curl loop shows up as a spike of unique visitors. Publishers
// should generate one opaque random id per machine at install time and pass it
// on every request. See the snippet in the slot manager.
//
// Returns an ASCII box (text/plain), sized to `cols`, with optional ANSI
// colour. Meant for shell MOTDs, SSH login banners, BBS screens, and CLI tools
// — anywhere an <iframe> can't go. Impressions are metered server-side by
// serveAd, exactly like the HTML paths; an unknown or inactive slot falls back
// to the (unmetered) CrawlProof house ad so a login banner is never blank.
//
// `slot` identifies the publisher placement being filled — that's who the
// impression and any click earnings are credited to. Omitting it (a bare curl
// of this URL) uses ADS_DEFAULT_SLOT_ID, the network's own slot, so the
// endpoint still rotates real campaigns on every load.

import { NextRequest, NextResponse } from "next/server";
import { serveAd } from "@/lib/ads/serve";
import { houseFill } from "@/lib/ads/house";
import { TERMINAL_FORMAT_ID } from "@/lib/ads/formats";
import { clampCols, renderCreativeText, terminalDeviceType } from "@/lib/ads/terminal";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { parseDevice } from "@/lib/tracker/device";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function headers(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "content-type": "text/plain; charset=utf-8",
    // Every request is a fresh fill + impression, so never cache at the edge.
    "cache-control": "no-store",
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, OPTIONS",
    vary: "Origin",
    "x-robots-tag": "noindex",
  };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: headers(request) });
}

// color=1 / true / yes / ansi all opt into ANSI escapes. Default is plain text:
// a consumer piping us into a file or a web page must not get escape codes.
function wantsColor(v: string | null): boolean {
  return v !== null && /^(1|true|yes|ansi|on)$/i.test(v);
}

// Optional publisher-supplied surface tag (?src=bbs, ?src=ssh-banner, …). It
// rides along on the click URL so one slot can tell its surfaces apart in the
// advertiser's own analytics. Sanitised hard: it ends up in a printed URL.
function cleanSrc(v: string | null): string {
  return (v ?? "").trim().replace(/[^\w.-]/g, "").slice(0, 32);
}

function withParam(rawUrl: string, key: string, value: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export async function GET(request: NextRequest) {
  const h = headers(request);
  try {
    const url = new URL(request.url);
    // No ?slot= (someone just curling the bare URL) falls back to the network's
    // default slot, so the endpoint rotates real campaigns on every load
    // instead of only ever showing the house ad. Serving needs *a* slot: the
    // impression row is what a click later resolves back to.
    const slotId = url.searchParams.get("slot") || env.adsDefaultSlotId;
    const visitorId = url.searchParams.get("v");
    const cols = clampCols(url.searchParams.get("cols") ?? url.searchParams.get("width"));
    const color = wantsColor(url.searchParams.get("color"));
    const src = cleanSrc(url.searchParams.get("src"));

    let fill = null;
    if (slotId) {
      const ip = clientIpFromHeaders(request.headers);
      const geo = await lookupGeo(ip).catch(() => null);
      // Terminal clients identify as curl/wget/etc., which the generic tracker
      // buckets as "bot" — correct for a web page, wrong here, where that's the
      // actual audience. terminalDeviceType keeps real crawlers out and lets
      // shell clients through; anything else falls back to normal parsing.
      const ua = request.headers.get("user-agent");
      const device = terminalDeviceType(ua) ?? parseDevice(ua).deviceType;
      fill = await serveAd(slotId, TERMINAL_FORMAT_ID, {
        visitorId,
        ip,
        country: geo?.countryCode ?? null,
        device,
        // Recorded on the impression, so the printed click URL doesn't have to
        // carry it. /a/<code> reads it back when it builds utm_content.
        src: src || null,
      });
    }
    // No slot given, or the slot is inactive / has no terminal inventory.
    if (!fill) fill = houseFill(TERMINAL_FORMAT_ID);

    // Re-render at the caller's width/colour from the same creative + click URL
    // the fill was metered with. House fills keep their own border label so an
    // unsold slot doesn't read as a paid placement.
    //
    // The click URL is printed as literal text, so every character here is a
    // character of box width. A paid fill already carries the surface tag on
    // its impression row, so nothing is appended — that's what keeps /a/<code>
    // inside a 44-col box. House fills have no impression row, so theirs still
    // rides the URL, where /h has the room for it.
    const isHouse = fill.campaignId === "house";
    const clickUrl = src && isHouse ? withParam(fill.clickUrl, "s", src) : fill.clickUrl;
    const body = renderCreativeText(fill.creative, clickUrl, {
      cols,
      color,
      label: isHouse ? "CRAWLPROOF ADS" : undefined,
    });
    return new NextResponse(`${body}\n`, { status: 200, headers: h });
  } catch {
    // Never fail a login banner: fall back to the house ad at defaults.
    const fallback = houseFill(TERMINAL_FORMAT_ID);
    return new NextResponse(`${fallback.text}\n`, { status: 200, headers: h });
  }
}
