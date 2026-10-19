// /api/tracker/v1/report — every site on the token's account, summarised.
//
//   GET ?range=1w|1m → { range, generated_at, sites: [...], truncated, totals, token_scope }
//
// What CoinPay's business report reads when a merchant connects CrawlProof.
// Accepts read-only `stats:read` tokens as well as full ones; the sites are
// always the token owner's and nothing in the query can name another account.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer, STATS_READ } from "@/lib/sp/apiAuth";
import { ownerReport, parseReportRange } from "@/lib/tracker/ownerReport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req, { allowScopes: [STATS_READ] });
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const range = parseReportRange(req.nextUrl.searchParams.get("range"));
  if (!range) return NextResponse.json({ error: "Unknown range. Expected 1w or 1m." }, { status: 400 });

  const result = await ownerReport(serviceClient(), auth.userId, range);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  // The token's own scope rides along, so a client that should only ever hold
  // a read-only token (CoinPay) can refuse a full-access one.
  return NextResponse.json({ ...result.report, token_scope: auth.scope });
}
