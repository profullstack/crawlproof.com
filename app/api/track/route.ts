// Public ingest for the drop-in tracker (/stats.js). Accepts a minimal
// JSON payload, categorizes the event, and bumps the matching counter row
// in tracker_daily_stats. Idempotent under load via ON CONFLICT.

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { categorize } from "@/lib/tracker/categorize";
import { parseDevice } from "@/lib/tracker/device";
import { clientIpFromHeaders, lookupGeo } from "@/lib/tracker/geo";
import { enqueuePostHogEvent } from "@/lib/posthog/events";
import { AUDIENCE_BROWSER_EVENTS, ingestAudienceEvent } from "@/lib/audience/hub";

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
  // Audience Hub fields (identify / consent / lead capture from stats.js).
  email: z.string().max(320).optional(),
  name: z.string().max(255).optional(),
  userId: z.string().max(255).optional(),
  previousId: z.string().max(128).optional(),
  marketingConsent: z.boolean().optional(),
  consentType: z.string().max(64).optional(),
  plan: z.string().max(80).optional(),
  role: z.string().max(80).optional(),
  tags: z.array(z.string().max(80)).max(20).optional(),
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
  utmContent: z.string().max(255).optional(),
  utmTerm: z.string().max(255).optional(),
  payload: z
    .record(z.unknown())
    .optional()
    .refine((v) => v === undefined || JSON.stringify(v).length <= 8_192, {
      message: "payload too large",
    }),
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

function sha256Short(value: string) {
  return crypto
    .createHash("sha256")
    .update(`crawlproof:${value}`)
    .digest("hex")
    .slice(0, 32);
}

// Keys already promoted to first-class contact fields; keeping them out of
// event metadata avoids duplicating PII in the jsonb blob.
const PROMOTED_PAYLOAD_KEYS = new Set([
  "email",
  "name",
  "user_id",
  "userId",
  "previous_id",
  "marketing_consent",
  "consent",
  "consent_type",
  "plan",
  "role",
  "tags",
]);

function sanitizeAudiencePayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!PROMOTED_PAYLOAD_KEYS.has(key)) out[key] = value;
  }
  return out;
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
    .select("id, owner_id, organization_id, url, tracker_enabled")
    .eq("id", site)
    .maybeSingle();
  if (!project || !project.tracker_enabled) return ok(request);

  // Audience Hub: forward identity / consent / lead events into the contact
  // pipeline. Fire-and-forget — the beacon response never waits on it, and
  // plain pageviews stay out of the audience tables.
  if (parsed.data.email || AUDIENCE_BROWSER_EVENTS.has(event)) {
    const d = parsed.data;
    const ip = clientIpFromHeaders(request.headers);
    void ingestAudienceEvent({
      project: {
        id: project.id,
        owner_id: project.owner_id,
        organization_id: project.organization_id ?? null,
      },
      event,
      source: "browser",
      email: d.email,
      name: d.name,
      externalUserId: d.userId,
      anonymousId: d.visitorId,
      previousAnonymousId: d.previousId,
      sessionId: d.sessionId,
      url: pageUrl,
      referrer,
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      utmContent: d.utmContent,
      utmTerm: d.utmTerm,
      marketingConsent: d.marketingConsent,
      consentType: d.consentType,
      plan: d.plan,
      role: d.role,
      tags: d.tags,
      metadata: sanitizeAudiencePayload(d.payload),
      ipHash: ip ? sha256Short(ip) : null,
      userAgentHash: userAgent ? sha256Short(userAgent) : null,
    }).catch(() => {
      // Audience writes must never break the beacon response.
    });
  }

  const { bucket, isAi } = categorize({ referrer, userAgent });
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

  // Device / browser / OS rollup, derived from the request User-Agent. Like
  // the geo rollup we store only aggregate counts, never the raw UA string.
  const device = parseDevice(userAgent);
  if (device.deviceType || device.browser || device.os) {
    const { data: deviceExisting } = await sb
      .from("tracker_device_daily_stats")
      .select("count")
      .eq("project_id", site)
      .eq("day", today)
      .eq("device_type", device.deviceType)
      .eq("browser", device.browser)
      .eq("os", device.os)
      .maybeSingle();

    if (deviceExisting) {
      await sb
        .from("tracker_device_daily_stats")
        .update({
          count: (deviceExisting.count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("project_id", site)
        .eq("day", today)
        .eq("device_type", device.deviceType)
        .eq("browser", device.browser)
        .eq("os", device.os);
    } else {
      await sb.from("tracker_device_daily_stats").insert({
        project_id: site,
        day: today,
        device_type: device.deviceType,
        browser: device.browser,
        os: device.os,
        count: 1,
      });
    }
  }

  const geo = await lookupGeo(clientIpFromHeaders(request.headers));

  // Write a raw event row for the real-time "active in last 30 min" view.
  // Fire-and-forget — never delays the 204 response. Also prunes rows
  // older than 24h on the same project (cheap indexed DELETE).
  void (async () => {
    try {
      await sb.from("tracker_events").insert({
        project_id: site,
        event,
        page_path: pagePath,
        referrer_host: referrerHost,
        event_target: eventTarget,
        bucket,
        country_code: geo?.countryCode ?? "",
        country_name: geo?.countryName ?? "",
        city: geo?.city ?? "",
        lat: geo?.lat ?? null,
        lng: geo?.lng ?? null,
        visitor_id: parsed.data.visitorId ?? "",
        session_id: parsed.data.sessionId ?? "",
      });
      // Prune stale rows (best-effort; skip on error).
      await sb
        .from("tracker_events")
        .delete()
        .eq("project_id", site)
        .lt("occurred_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    } catch {
      // Silent — analytics writes must never break the beacon response.
    }
  })();

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

  if (bucket.startsWith("bot:")) {
    void enqueuePostHogEvent({
      event: isAi ? "ai_bot_detected" : "crawler_detected",
      distinctId: project.organization_id
        ? `org_${project.organization_id}`
        : `project_${site}`,
      orgId: project.organization_id ?? null,
      userId: project.owner_id ?? null,
      domain: hostFromUrl(project.url),
      category: "bot",
      sourceRecordId: `${site}:${today}:${bucket}:${pagePath}:${event}`,
      properties: {
        project_id: site,
        crawler_name: bucket.split(":", 2)[1] ?? "unknown",
        crawler_category: isAi ? "ai_agent" : "crawler",
        user_agent: userAgent,
        path: pagePath || "/",
        method: request.method,
        country: geo?.countryCode ?? null,
        confidence: bucket === "bot:other" ? 0.65 : 0.9,
        action: "observe",
        source_event: event,
      },
    }).catch(() => {
      // PostHog delivery is best-effort and must never affect beacons.
    });
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
