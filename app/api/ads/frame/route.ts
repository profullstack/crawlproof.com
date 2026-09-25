// No-JS ad frame. Publishers embed a plain, script-free tag:
//   <iframe src="https://crawlproof.com/api/ads/frame?slot=<id>&format=banner_300x250"
//           width="300" height="250" frameborder="0" scrolling="no"
//           style="border:0;max-width:100%" loading="lazy"></iframe>
// Unlike /ad.js (which fetches JSON and injects a srcdoc iframe), this returns a
// full HTML document so the ad renders and is clickable with zero JavaScript on
// the host page. That makes it embeddable on JS-restricted contexts such as Tor
// hidden services. The click link (target="_blank") lives inside CrawlProof's
// own document, so the host page can never intercept it. Impressions are metered
// server-side in serveAd, exactly like the JSON path.
//
// Because there is no script, there is also no theme detection: this document
// carries both palettes and lets its own `prefers-color-scheme` decide. Pass
// `&theme=light` or `&theme=dark` to pin it.
//
// ONE exception to "no script", added deliberately and narrowly: a fill that
// rendered as video or as the audible companion carries a small measurement
// script. It is the only way to know whether a video ad actually played, it
// runs inside THIS document rather than the host page (so the zero-JS promise
// to the publisher is unchanged), and a reader with JavaScript off still gets
// the ad — the unit renders and clicks exactly as before, it simply reports
// nothing. Every other medium is served as script-free as it has always been.

import { NextRequest, NextResponse } from "next/server";
import { serveAd, isAdFormat } from "@/lib/ads/serve";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { parseDevice } from "@/lib/tracker/device";
import { serviceClient } from "@/lib/supabase/service";
import { recordDecision } from "@/lib/ads/video/decisions";
import { bannerBeaconScript, injectBannerBeacon } from "@/lib/ads/video/bannerBeacon";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Minimal empty document so an unfilled slot renders as blank rather than a
// broken frame. Never blocks the host page.
const EMPTY_HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>';

// Framed cross-origin by design (host sites, incl. .onion). We deliberately do
// NOT send X-Frame-Options / a restrictive frame-ancestors here.
function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "frame-ancestors *",
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const slotId = url.searchParams.get("slot");
    const format = url.searchParams.get("format");
    const visitorId = url.searchParams.get("v");
    if (!slotId || !isAdFormat(format)) return htmlResponse(EMPTY_HTML);

    // Unlike /ad.js, nothing on this path can look at the page the unit is
    // sitting in — that is the entire point of a script-free embed, and it used
    // to mean every frame rendered dark and a light publisher got a black bar
    // punched into their page. So the default here is 'auto': the creative
    // ships both palettes and the media query inside this document asks the
    // browser directly. A publisher who knows better (or has set the slot's
    // theme) still overrides it.
    const theme = url.searchParams.get("theme") ?? "auto";

    // Pin the presentation instead of rotating — `&media=static` for a publisher
    // who does not want motion in their page, `&media=gif` to look at one. Absent
    // is the default and rotates, which is what every embed already installed
    // sends and why none of them has to be edited to receive video.
    const media = url.searchParams.get("media");

    const ip = clientIpFromHeaders(request.headers);
    const geo = await lookupGeo(ip).catch(() => null);
    const device = parseDevice(request.headers.get("user-agent")).deviceType;

    const fill = await serveAd(slotId, format, {
      visitorId,
      ip,
      country: geo?.countryCode ?? null,
      device,
      theme,
      media,
    });

    if (!fill) return htmlResponse(EMPTY_HTML);

    // Only the media that can actually report anything. A static banner has
    // no playback to measure and gets no script.
    if (fill.media !== "video" && fill.media !== "audio") {
      return htmlResponse(fill.html);
    }

    const decisionId = await recordDecision(serviceClient(), {
      slotId,
      // No playback session on a display surface: the unit is drawn once and
      // a reload is a genuinely new impression, so the fill is its own session.
      sessionId: crypto.randomUUID(),
      placement: "in_banner",
      kind: fill.media === "audio" ? "audio" : "video",
      surface: "web",
      fill,
      assetRevision: null,
    });

    // Unmeasurable is not unservable: without a decision to report against
    // there is nothing to put in the script, and the ad goes out as it is.
    if (!decisionId) return htmlResponse(fill.html);

    return htmlResponse(
      injectBannerBeacon(fill.html, bannerBeaconScript(decisionId, env.siteUrl)),
    );
  } catch {
    return htmlResponse(EMPTY_HTML);
  }
}
