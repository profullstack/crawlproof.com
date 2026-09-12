// /api/ads/v1/trends — what is trending, for advertisers choosing targeting.
//
//   GET ?window=7&limit=50&stale=1
//       The current signals, newest ingest, highest score first. `stale=1`
//       includes a list too old to steer delivery, which is how the CLI can
//       explain why nothing is being boosted rather than showing an empty
//       page that looks like a bug.
//
// Same bearer auth as the rest of /api/ads/v1: `Authorization: Bearer crp_…`.
// Ingestion is not here — it runs on a schedule and is gated on the cron
// secret (app/api/cron/ad-trends).

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { currentTrends } from "@/lib/ads/trends";
import { TREND_MAX_AGE_HOURS, TREND_SOURCE, TREND_WINDOW_DAYS, trendsAreStale } from "@/lib/ads/trending";
import { TRENDING_CPC_CENTS } from "@/lib/ads/pricing";
import { PROMO_DAYS } from "@/lib/ads/trending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const params = new URL(req.url).searchParams;
  const windowDays = Number(params.get("window")) || TREND_WINDOW_DAYS;
  const limit = Number(params.get("limit")) || 50;
  const includeStale = params.get("stale") === "1" || params.get("stale") === "true";

  const now = Date.now();
  const signals = await currentTrends(serviceClient(), { windowDays, limit, includeStale, now });
  const newest = signals.reduce<string | null>(
    (latest, signal) => (!latest || (signal.ingestedAt ?? "") > latest ? (signal.ingestedAt ?? latest) : latest),
    null,
  );

  return NextResponse.json({
    source: TREND_SOURCE,
    window_days: windowDays,
    ingested_at: newest,
    // A list this old no longer steers delivery; saying so is the difference
    // between "nothing is trending" and "the puller has been down since
    // Tuesday", which look identical from the outside.
    stale: trendsAreStale(newest, now),
    max_age_hours: TREND_MAX_AGE_HOURS,
    promo: { kind: "trending_premium_90", days: PROMO_DAYS, cpc_cents: TRENDING_CPC_CENTS },
    topics: signals.map((signal) => ({
      topic: signal.topic,
      score: signal.score,
      mentions: signal.mentions,
      prior_mentions: signal.priorMentions,
      generated_at: signal.generatedAt,
      ingested_at: signal.ingestedAt,
    })),
  });
}
