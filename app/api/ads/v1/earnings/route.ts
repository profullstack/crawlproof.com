import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { loadEarnings } from "@/lib/ads/earnings-data";
import { loadTokenDelivery } from "@/lib/ads/token-earnings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function parseDays(raw: string | null): number {
  const n = Number(raw);
  return [7, 30, 90, 365].includes(n) ? n : 30;
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const days = parseDays(req.nextUrl.searchParams.get("days"));
  try {
    const sb = serviceClient();
    const model = await loadEarnings(sb, auth.userId, days, loadTokenDelivery(sb, auth.userId, days));
    if (model.statsUnavailable) throw new Error("incomplete_reporting");
    return NextResponse.json({ ...model, deliveryWindow: "range", clickSemantics: "accepted_billed_plus_free" }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    console.error("[ads] Earnings response unavailable");
    return NextResponse.json({ error: "Ad reporting is temporarily unavailable. Please retry.", statsUnavailable: true }, {
      status: 503, headers: { "retry-after": "5", "cache-control": "no-store" },
    });
  }
}
