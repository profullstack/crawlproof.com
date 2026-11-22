// /api/abtest/v1/events
//
//   POST { experiment, unit, type, name?, value?, arm?, id? }
//   POST { events: [ ...up to 100 of the above ] }
//
// type: exposure (the unit saw the treatment; the conversion denominator),
//       conversion, revenue (value = amount), event (named engagement, needs name).
// id is an idempotency key: the same id counts once per experiment (duplicate: true).
// The unit is assigned first if it never was, so its events land in its sticky arm.
import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { recordEvents, type EventInput } from "@/lib/abtest/store";
import { authed, errorResponse, jsonBody } from "@/lib/abtest/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  try {
    const body = (await jsonBody(req)) as { events?: EventInput[] } & EventInput;
    const batch = Array.isArray(body?.events);
    const results = await recordEvents(serviceClient(), a.userId, batch ? body.events! : [body]);
    return NextResponse.json(batch ? { results } : results[0]);
  } catch (e) {
    return errorResponse(e);
  }
}
