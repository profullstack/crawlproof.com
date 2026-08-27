// Public ad fill endpoint. The /ad.js tag calls this with a slot id + desired
// format and renders the returned HTML inside an isolated iframe. Metering
// (impression insert) happens server-side in serveAd. Best-effort: any failure
// returns an empty fill so the host page is never affected.

import { NextRequest, NextResponse } from "next/server";
import { serveAd, isAdFormat } from "@/lib/ads/serve";
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
    "cache-control": "no-store",
    vary: "Origin",
  };
}

export function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(request) });
}

export async function GET(request: NextRequest) {
  const headers = cors(request);
  try {
    const url = new URL(request.url);
    const slotId = url.searchParams.get("slot");
    const format = url.searchParams.get("format");
    const visitorId = url.searchParams.get("v");
    // What the tag measured on the publisher's page. Anything other than
    // light/dark (including absent) defers to the slot's stored default.
    const theme = url.searchParams.get("theme");
    // Width of the container the tag measured, so serving can decline to send a
    // unit that cannot fit it. Absent on older tags — serveAd then honours the
    // requested format unchanged.
    const width = Number(url.searchParams.get("w"));
    if (!slotId || !isAdFormat(format)) {
      return NextResponse.json({ ok: false }, { status: 200, headers });
    }

    const ip = clientIpFromHeaders(request.headers);
    const geo = await lookupGeo(ip).catch(() => null);
    const device = parseDevice(request.headers.get("user-agent")).deviceType;

    const fill = await serveAd(slotId, format, {
      visitorId,
      ip,
      country: geo?.countryCode ?? null,
      device,
      theme,
      width: Number.isFinite(width) && width > 0 ? width : null,
    });

    if (!fill) return NextResponse.json({ ok: false }, { status: 200, headers });

    return NextResponse.json(
      {
        ok: true,
        impressionId: fill.impressionId,
        html: fill.html,
        clickUrl: fill.clickUrl,
        // What was actually served, which is not always what was asked for —
        // the tag sizes its iframe from this.
        format: fill.creative.format,
      },
      { status: 200, headers },
    );
  } catch {
    return NextResponse.json({ ok: false }, { status: 200, headers });
  }
}
