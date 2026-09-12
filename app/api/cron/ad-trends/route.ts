// Pull the trend list in. Run it hourly.
//
// Server to server in both directions: this route is gated on CRON_SECRET the
// same way every other cron route is, and it presents SAMEBRAIN_SECRET to the
// source. Neither secret belongs in a committed .env file — both are set on
// the Railway service and kept in the vault (logicsrc team
// `crawlproof-com--prod`).
//
// A failed pull is not an outage. Serving keeps using the stored list until it
// ages out (TREND_MAX_AGE_HOURS), and after that every campaign simply falls
// back to its ordinary auction weight.

import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { ingestTrends } from "@/lib/ads/trends";
import { TREND_WINDOW_DAYS } from "@/lib/ads/trending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  // No cron secret configured means this route is closed, not open: it writes
  // the targeting signals every fill reads.
  if (!env.cronSecret || incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const windowDays = Number(new URL(req.url).searchParams.get("window")) || TREND_WINDOW_DAYS;
  const result = await ingestTrends(serviceClient(), {
    url: env.samebrainUrl,
    secret: env.samebrainSecret,
    windowDays,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
