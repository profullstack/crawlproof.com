// POST /api/earn/v1/transfer { to, amount_micros, reason? }
//
// Any party pays any party. A person paying an agent to do a job, an agent
// paying another agent for a summary, an agent paying a person for an answer:
// the rail does not distinguish them and deliberately so. `to` is an account
// id, which /api/earn/v1/me returns for whoever is asking.
//
// Moves only value that is already funded, so no transfer can affect the
// solvency of the reward pool.

import { NextResponse, type NextRequest } from "next/server";
import { resolveParty } from "@/lib/earn/accounts";
import { transfer } from "@/lib/earn/rail";
import { formatMicros } from "@/lib/earn/rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const party = await resolveParty(req);
  if (!party.ok) return NextResponse.json({ error: party.error }, { status: party.status });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const to = String(body.to ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(to)) {
    return NextResponse.json({ error: "`to` must be an account id." }, { status: 400 });
  }

  const result = await transfer({
    fromAccountId: party.account.id,
    toAccountId: to,
    amountMicros: Number(body.amount_micros),
    reason: body.reason == null ? null : String(body.reason).slice(0, 200),
    ref: body.ref == null ? null : String(body.ref).slice(0, 200),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({
    ledger_id: result.ledgerId,
    balance_micros: result.fromBalanceMicros,
    balance: formatMicros(result.fromBalanceMicros),
  });
}
