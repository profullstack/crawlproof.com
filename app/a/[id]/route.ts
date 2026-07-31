// Short ad click redirector: https://crawlproof.com/a/<impression_id>
//
// Terminal ads print their click URL as literal text into someone's shell, so
// the long /api/ads/click?i=…&s=…&c=…&cr=… form doesn't work — it wraps, it
// looks like spam, and it's unusable when hand-typed. This path carries only
// the impression id and re-reads slot/campaign/creative from the impression
// row, then hands off to the same resolveClick() metering as the web path.
//
// Unknown/expired ids (including unmetered house-ad fills, which never get an
// impression row) redirect to the site rather than dead-ending.

import { NextRequest, NextResponse } from "next/server";
import { resolveClick } from "@/lib/ads/serve";
import { serviceClient } from "@/lib/supabase/service";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { parseDevice } from "@/lib/tracker/device";
import { isShortCode } from "@/lib/ads/shortcode";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ImpressionRow = {
  id: string;
  slot_id: string;
  campaign_id: string;
  creative_id: string;
  visitor_id: string | null;
  src?: string | null;
};

const BASE_COLS = "id, slot_id, campaign_id, creative_id, visitor_id";

/**
 * Look up the impression by short code or UUID.
 *
 * `src` is a newer column and migrations here are applied by hand, so the app
 * can briefly run ahead of the schema. Ask for it, and if the projection fails
 * because the column isn't there yet, retry without it rather than dropping the
 * click — an unresolved click is a payout the publisher never sees. Only the
 * UUID path is worth retrying: a lookup *by* short code cannot succeed before
 * the migration anyway.
 */
async function findImpression(
  sb: ReturnType<typeof serviceClient>,
  id: string,
  byCode: boolean,
): Promise<ImpressionRow | null> {
  const column = byCode ? "short_code" : "id";
  const { data } = await sb
    .from("ad_impressions")
    .select(`${BASE_COLS}, src`)
    .eq(column, id)
    .maybeSingle();
  if (data) return data as ImpressionRow;
  if (byCode) return null;

  const { data: legacy } = await sb
    .from("ad_impressions")
    .select(BASE_COLS)
    .eq(column, id)
    .maybeSingle();
  return (legacy as ImpressionRow) ?? null;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const fallback = env.siteUrl || "https://crawlproof.com";
  try {
    const { id } = await ctx.params;
    // Two address forms. New fills use a 12-character short code, which is what
    // lets the URL fit inside a 44-col ASCII box. UUIDs are still accepted and
    // must stay that way: click URLs from before the change are sitting in
    // people's MOTDs, SSH banners and BBS screens, and those are not reissued.
    const byCode = isShortCode(id);
    if (!byCode && !UUID.test(id)) return NextResponse.redirect(fallback, { status: 302 });

    const sb = serviceClient();
    const imp = await findImpression(sb, id, byCode);
    if (!imp) return NextResponse.redirect(fallback, { status: 302 });

    const ip = clientIpFromHeaders(request.headers);
    const geo = await lookupGeo(ip).catch(() => null);
    // Deliberately the STRICT classification here, unlike /api/ads/motd: a
    // terminal ad is served to curl, but it's clicked from a browser when the
    // reader follows the link. Anyone can curl this URL in a loop, so scripted
    // hits stay unbilled (recorded with valid=false) rather than paying out.
    const device = parseDevice(request.headers.get("user-agent")).deviceType;

    const dest = await resolveClick({
      impressionId: imp.id,
      slotId: imp.slot_id,
      campaignId: imp.campaign_id,
      creativeId: imp.creative_id,
      ctx: {
        visitorId: imp.visitor_id,
        ip,
        country: geo?.countryCode ?? null,
        device,
      },
    });

    if (!dest) return NextResponse.redirect(fallback, { status: 302 });

    // Terminal traffic is invisible in an advertiser's analytics without a tag
    // — there's no referrer from a shell. resolveClick already appended
    // ?ref=<campaign slug>; add utm on top, plus the publisher's own ?src=
    // surface tag when the ad carried one. Never overwrite utm params the
    // advertiser put on their own destination URL.
    // Prefer the tag recorded on the impression; fall back to the query string
    // for the older URLs that still carry "&s=<tag>" inline.
    const q = new URL(request.url).searchParams;
    const src = imp.src ?? q.get("s") ?? q.get("src");
    return NextResponse.redirect(withTerminalUtm(dest, src), { status: 302 });
  } catch {
    return NextResponse.redirect(fallback, { status: 302 });
  }
}

function withTerminalUtm(dest: string, src: string | null): string {
  try {
    const u = new URL(dest);
    if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", "crawlproof");
    if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "terminal");
    const tag = (src ?? "").trim().replace(/[^\w.-]/g, "").slice(0, 32);
    if (tag && !u.searchParams.has("utm_content")) u.searchParams.set("utm_content", tag);
    return u.toString();
  } catch {
    return dest;
  }
}
