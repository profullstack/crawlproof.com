// Funnel tracking for the 30-day validation test (R6). Server side.
//
// Six events, each tagged with where the visitor came from:
//   audit_started, audit_completed, report_viewed, signup, checkout_started,
//   subscribed
// Source is one of organic | outreach | ranking. Outreach and ranking links
// carry `?src=outreach|ranking`; the browser keeps it in a first-party cookie
// for 30 days so a later signup or checkout is credited to the same source.
// A random visitor id cookie lets "came back on a second day" be counted.
//
// audit_completed is written by a database trigger (see the migration
// 20261118120000_validation_funnel_monitoring.sql), report_viewed by the
// browser beacon (/api/funnel), the rest here where they happen.
//
// Weekly counts: `select * from funnel_weekly order by week desc, source, event`.

import { serviceClient } from "@/lib/supabase/service";
import {
  parseSource,
  parseVisitorId,
  readCookieValue,
  SOURCE_COOKIE,
  VISITOR_COOKIE,
  type FunnelEvent,
  type FunnelSource,
} from "@/lib/funnel-shared";

export * from "@/lib/funnel-shared";

/** Source + visitor from a request's Cookie header. */
export function funnelContext(cookieHeader: string | null | undefined): {
  source: FunnelSource;
  visitorId: string | null;
} {
  return {
    source: parseSource(readCookieValue(cookieHeader, SOURCE_COOKIE)) ?? "organic",
    visitorId: parseVisitorId(readCookieValue(cookieHeader, VISITOR_COOKIE)),
  };
}

/** Record one event. Best effort: tracking must never break the action it measures. */
export async function recordFunnelEvent(input: {
  event: FunnelEvent;
  source?: FunnelSource | null;
  visitorId?: string | null;
  auditId?: string | null;
  userId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await serviceClient()
      .from("funnel_events")
      .insert({
        event: input.event,
        source: input.source ?? "organic",
        visitor_id: input.visitorId ?? null,
        audit_id: input.auditId ?? null,
        user_id: input.userId ?? null,
        meta: input.meta ?? {},
      });
    if (error) console.warn("[funnel] insert failed", input.event, error.message);
  } catch (err) {
    console.warn("[funnel] insert threw", input.event, err);
  }
}
