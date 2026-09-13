// POST /api/affiliate/v1/payout — send the approved balance now, if it is
// over the minimum. The weekly schedule does the same without asking.
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller } from "@/lib/affiliate/auth";
import { requestPayout } from "@/lib/affiliate/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const out = await requestPayout(caller.membership);
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: 400 });
  return NextResponse.json({ ok: true, payout: { id: out.payoutId, amount: out.amountCents / 100, tx: out.txHash, status: out.status } });
}
