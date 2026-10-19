// /api/ads/v1/slots/[id]/payout — withdraw a slot's earnings.
//
//   POST  Sends everything the slot can withdraw to its payout wallet through
//         CoinPay: { amount_cents, status: confirmed|sent|requested }. 400 with
//         the reason when there is no wallet or less than the minimum.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { requestSlotPayout } from "@/lib/ads/payouts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  const sb = serviceClient();
  const { data: who } = await sb.auth.admin.getUserById(auth.userId);
  const result = await requestSlotPayout({ sb, userId: auth.userId, email: who?.user?.email ?? null, slotId: id });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "Slot not found." ? 404 : 400 });
  return NextResponse.json({ amount_cents: result.amountCents, status: result.status });
}
