// /api/ads/v1/earnings — the account's ad money and delivery, for a token caller.
//
//   GET ?days=7|30|90|365
//
// The same model /dashboard/ads/earnings renders, for something holding an API
// token. It exists because the alternative for a client that wants fleet totals
// is one /campaigns/[id] request per campaign, and the account is past 170 of
// them — see `crawlproof dashboard`, which polls this on a timer.
//
// Same auth as the rest of /api/ads/v1/*: `Authorization: Bearer crp_…`.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { loadEarnings } from "@/lib/ads/earnings-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90, 365];

/** An unknown window falls back to 30 rather than reaching the query planner. */
export function parseDays(raw: string | null): number {
  const n = Number(raw);
  return ALLOWED_DAYS.includes(n) ? n : 30;
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const days = parseDays(req.nextUrl.searchParams.get("days"));
  // The service client has no RLS. loadEarnings filters every table by
  // owner_id itself, which is what makes passing it here safe.
  const model = await loadEarnings(serviceClient(), auth.userId, days);
  return NextResponse.json(model);
}
