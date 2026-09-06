// POST /api/earn/v1/payout { amount_cents? } — take the balance off the rail.
//
// USDC through the same CoinPay endpoint the publisher withdrawals use.
// Omitting the amount withdraws everything available. The balance is debited
// before CoinPay is called, so two requests in flight cannot both be funded,
// and a send that fails puts it back.

import { NextResponse, type NextRequest } from "next/server";
import { resolveParty } from "@/lib/earn/accounts";
import { requestPayout } from "@/lib/earn/rail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The upstream sends on-chain synchronously.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const party = await resolveParty(req);
  if (!party.ok) return NextResponse.json({ error: party.error }, { status: party.status });

  let body: { amount_cents?: unknown } = {};
  try {
    body = (await req.json()) as { amount_cents?: unknown };
  } catch {
    // An empty body means "all of it", which is the common case.
  }

  const asked = body.amount_cents == null ? undefined : Math.floor(Number(body.amount_cents));
  if (asked !== undefined && (!Number.isFinite(asked) || asked <= 0)) {
    return NextResponse.json({ error: "amount_cents must be a positive whole number." }, { status: 400 });
  }

  const result = await requestPayout({ account: party.account, amountCents: asked });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({
    payout_id: result.payoutId,
    amount_cents: result.amountCents,
    tx_hash: result.txHash,
  });
}
