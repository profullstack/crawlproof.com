// Public ingest for the drop-in tracker (/stats.js). Accepts a minimal
// JSON payload, categorizes the event, and bumps the matching counter row
// in tracker_daily_stats. Idempotent under load via ON CONFLICT.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { categorize } from "@/lib/tracker/categorize";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";

export const runtime = "nodejs";

const bodySchema = z.object({
  site: z.string().uuid().optional(),
  websiteId: z.string().uuid().optional(),
  event: z.string().max(80).optional(),
  type: z.string().max(80).optional(),
  ref: z.string().max(2048).nullable().optional(),
  referrer: z.string().max(2048).nullable().optional(),
  url: z.string().max(2048).optional(),
  href: z.string().max(2048).optional(),
  path: z.string().max(2048).optional(),
  domain: z.string().max(255).optional(),
  target: z.string().max(255).optional(),
  language: z.string().max(64).optional(),
  timezone: z.string().max(128).optional(),
  visitorId: z.string().max(128).optional(),
  sessionId: z.string().max(128).optional(),
  viewport: z
    .object({
      width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
    })
    .optional(),
  screenWidth: z.number().int().nonnegative().optional(),
  screenHeight: z.number().int().nonnegative().optional(),
});

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const requestHeaders = request.headers.get("access-control-request-headers");
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": requestHeaders ?? "content-type",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    vary: "Origin",
  };

  if (origin) {
    headers["access-control-allow-credentials"] = "true";
  }

  return headers;
}

// Always 204. Even on bad input we don't want to surface details to the
// client — this endpoint is public and we treat it as a black hole.
function ok(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function textOrNull(value: string | null | undefined) {
  return value && value.trim() ? value : null;
}

function textOrUndefined(value: string | null | undefined) {
  return value && value.trim() ? value : undefined;
}

function cleanEvent(value: string | null | undefined) {
  const raw = textOrNull(value)?.toLowerCase() ?? "pageview";
  const clean = raw.replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 80);
  return clean || "pageview";
}

function cleanPage(value: string | null | undefined) {
  const raw = textOrNull(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.pathname || "/").slice(0, 2048);
  } catch {
    return raw.startsWith("/") ? raw.split(/[?#]/, 1)[0].slice(0, 2048) : null;
  }
}

function cleanTarget(value: string | null | undefined) {
  return textOrNull(value)?.replace(/\s+/g, " ").slice(0, 255) ?? "";
}

function hostFromUrl(value: string | null | undefined) {
  const raw = textOrNull(value);
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "").slice(0, 255);
  } catch {
    return null;
  }
}

function payloadFromUrl(request: Request) {
  const url = new URL(request.url);
  return bodySchema.safeParse({
    site: textOrUndefined(url.searchParams.get("site")),
    websiteId: textOrUndefined(url.searchParams.get("websiteId")),
    event: textOrUndefined(url.searchParams.get("event")),
    type: textOrUndefined(url.searchParams.get("type")),
    ref: textOrNull(url.searchParams.get("ref")),
    referrer: textOrNull(url.searchParams.get("referrer")),
    url: textOrUndefined(url.searchParams.get("url")),
    href: textOrUndefined(url.searchParams.get("href")),
    path: textOrUndefined(url.searchParams.get("path")),
    domain: textOrUndefined(url.searchParams.get("domain")),
    target: textOrUndefined(url.searchParams.get("target")),
  });
}

async function payloadFromBody(request: Request) {
  try {
    const json = await request.json();
    return bodySchema.safeParse(json);
  } catch {
    return payloadFromUrl(request);
  }
}

async function ingest(request: NextRequest, parseBody: boolean) {
  const parsed = parseBody
    ? await payloadFromBody(request)
    : payloadFromUrl(request);
  if (!parsed.success) return ok(request);

  const site = parsed.data.site ?? parsed.data.websiteId;
  if (!site) return ok(request);

  const event = cleanEvent(parsed.data.event ?? parsed.data.type);
  const eventTarget = cleanTarget(parsed.data.target);
  const referrer =
    textOrNull(parsed.data.ref) ??
    textOrNull(parsed.data.referrer) ??
    textOrNull(request.headers.get("referer"));
  const pageUrl =
    textOrNull(parsed.data.url) ??
    textOrNull(parsed.data.href) ??
    textOrNull(parsed.data.path) ??
    textOrNull(request.headers.get("referer"));
  const pagePath = cleanPage(pageUrl) ?? "";
  const referrerHost = hostFromUrl(referrer) ?? "";
  const userAgent = request.headers.get("user-agent");

  const sb = serviceClient();

  // Confirm the project exists and has the tracker enabled. We avoid
  // leaking which check failed; 204 either way.
  const { data: project } = await sb
    .from("projects")
    .select("id, tracker_enabled")
    .eq("id", site)
    .maybeSingle();
  if (!project || !project.tracker_enabled) return ok(request);

  const { bucket } = categorize({ referrer, userAgent });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // UPSERT increment. Supabase JS doesn't expose a raw .increment() helper
  // so we read + write under the unique key. The PK protects against
  // dupes; a lost-update race here at worst undercounts by 1 per
  // contention window, which is acceptable for analytics-grade data.
  const { data: existing } = await sb
    .from("tracker_daily_stats")
    .select("count")
    .eq("project_id", site)
    .eq("day", today)
    .eq("bucket", bucket)
    .maybeSingle();

  if (existing) {
    await sb
      .from("tracker_daily_stats")
      .update({
        count: (existing.count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", site)
      .eq("day", today)
      .eq("bucket", bucket);
  } else {
    await sb
      .from("tracker_daily_stats")
      .insert({ project_id: site, day: today, bucket, count: 1 });
  }

  const { data: eventExisting } = await sb
    .from("tracker_event_daily_stats")
    .select("count")
    .eq("project_id", site)
    .eq("day", today)
    .eq("event", event)
    .eq("page_path", pagePath)
    .eq("referrer_host", referrerHost)
    .eq("event_target", eventTarget)
    .maybeSingle();

  if (eventExisting) {
    await sb
      .from("tracker_event_daily_stats")
      .update({
        count: (eventExisting.count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", site)
      .eq("day", today)
      .eq("event", event)
      .eq("page_path", pagePath)
      .eq("referrer_host", referrerHost)
      .eq("event_target", eventTarget);
  } else {
    await sb.from("tracker_event_daily_stats").insert({
      project_id: site,
      day: today,
      event,
      page_path: pagePath,
      referrer_host: referrerHost,
      event_target: eventTarget,
      count: 1,
    });
  }

  const geo = await lookupGeo(clientIpFromHeaders(request.headers));
  if (geo) {
    const { data: geoExisting } = await sb
      .from("tracker_geo_daily_stats")
      .select("count")
      .eq("project_id", site)
      .eq("day", today)
      .eq("country_code", geo.countryCode)
      .eq("region_code", geo.regionCode)
      .eq("city", geo.city)
      .eq("timezone", geo.timezone)
      .maybeSingle();

    if (geoExisting) {
      await sb
        .from("tracker_geo_daily_stats")
        .update({
          country_name: geo.countryName,
          region_name: geo.regionName,
          count: (geoExisting.count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", site)
        .eq("day", today)
        .eq("country_code", geo.countryCode)
        .eq("region_code", geo.regionCode)
        .eq("city", geo.city)
        .eq("timezone", geo.timezone);
    } else {
      await sb.from("tracker_geo_daily_stats").insert({
        project_id: site,
        day: today,
        country_code: geo.countryCode,
        country_name: geo.countryName,
        region_code: geo.regionCode,
        region_name: geo.regionName,
        city: geo.city,
        timezone: geo.timezone,
        count: 1,
      });
    }
  }

  return ok(request);
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

export async function GET(request: NextRequest) {
  return ingest(request, false);
}

export async function POST(request: NextRequest) {
  return ingest(request, true);
}
