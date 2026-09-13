// GET /api/affiliate/v1/ledger?since=… — the caller's own ledger (spec, "The ledger").
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller } from "@/lib/affiliate/auth";
import { ledgerFor } from "@/lib/affiliate/memberships";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET, OPTIONS" };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status, headers: CORS });
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) return NextResponse.json({ error: "since must be ISO 8601." }, { status: 400, headers: CORS });
  const ledger = await ledgerFor(caller.membership, since);
  return NextResponse.json(ledger, { headers: { ...CORS, "cache-control": "no-store" } });
}
