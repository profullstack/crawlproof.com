// /api/ads/v1/deposits/[id] — one ad-budget deposit by CoinPay payment id.
//
//   GET  { payment_id, amount_usd, credits, status: pending|complete|failed }.
//        A pending deposit is checked with CoinPay first, the same self-heal
//        /api/credits/status does, so a dropped webhook still credits.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { reconcileFromCoinpay } from "@/lib/credits-finalize";
import { AD_BUDGET_PACK } from "@/lib/ads/deposits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  const sb = serviceClient();
  const read = () =>
    sb
      .from("credit_purchases")
      .select("owner_id, pack_id, coinpay_payment_id, amount_cents, credits_added, status, created_at, completed_at")
      .eq("coinpay_payment_id", id)
      .maybeSingle();
  let { data: row } = await read();
  if (!row || row.owner_id !== auth.userId || row.pack_id !== AD_BUDGET_PACK) {
    return NextResponse.json({ error: "No such deposit." }, { status: 404 });
  }
  if (row.status === "pending") {
    try {
      await reconcileFromCoinpay({ paymentId: id });
      row = (await read()).data ?? row;
    } catch (err) {
      console.error("[ads.deposits] reconcile failed", err);
    }
  }
  return NextResponse.json({
    payment_id: row.coinpay_payment_id,
    amount_usd: row.amount_cents / 100,
    credits: row.credits_added,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
  });
}
