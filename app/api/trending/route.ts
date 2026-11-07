// GET /api/trending?limit=50 — the list behind /trending, open and with no key.
// The token-authed /api/ads/v1/trends adds what advertisers need on top.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { publicTrendList } from "@/lib/ads/trendList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limit = Number(new URL(req.url).searchParams.get("limit")) || 50;
  const list = await publicTrendList(serviceClient(), { limit });
  return NextResponse.json(list, {
    headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" },
  });
}
