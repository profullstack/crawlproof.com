// POST /api/earn/v1/wallet { address } — where this account's earnings go.
//
// One address per account and never two accounts on one, enforced by a unique
// index. That is the cheapest control there is against sock puppets: ten
// accounts sharing a wallet is ten accounts sharing one account's daily cap.

import { NextResponse, type NextRequest } from "next/server";
import { resolveParty, setPayoutAddress } from "@/lib/earn/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const party = await resolveParty(req);
  if (!party.ok) return NextResponse.json({ error: party.error }, { status: party.status });

  let body: { address?: unknown };
  try {
    body = (await req.json()) as { address?: unknown };
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const result = await setPayoutAddress(party.account.id, String(body.address ?? ""));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ address: result.address });
}
