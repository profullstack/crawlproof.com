import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { reconcileFromCoinpay } from "@/lib/credits-finalize";

export const runtime = "nodejs";

// GET /api/credits/status?payment_id=...
// Returns the local credit_purchases.status, bumped to 'complete' by the
// CoinPay webhook. As a self-heal, if the local row is still 'pending' we
// ask CoinPay directly — if the upstream payment is paid, we run the same
// completion RPC the webhook would. Only the owner of the purchase can poll.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const paymentId = searchParams.get("payment_id");
  if (!paymentId) {
    return NextResponse.json({ ok: false, error: "missing_payment_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const svc = serviceClient();
  const { data: row } = await svc
    .from("credit_purchases")
    .select("owner_id, status, completed_at, credits_added")
    .eq("coinpay_payment_id", paymentId)
    .maybeSingle();
  if (!row || row.owner_id !== user.id) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // If still pending locally, ask CoinPay directly. The webhook may have
  // been dropped, delayed, or arrived with an unverifiable signature — we
  // shouldn't leave the customer staring at a spinner forever.
  if (row.status === "pending") {
    try {
      await reconcileFromCoinpay({ paymentId });
    } catch (err) {
      console.error("[credits.status] reconcile failed", err);
    }
    // Re-read after reconciliation.
    const { data: fresh } = await svc
      .from("credit_purchases")
      .select("status, completed_at, credits_added")
      .eq("coinpay_payment_id", paymentId)
      .maybeSingle();
    return NextResponse.json({
      ok: true,
      status: fresh?.status ?? "pending",
      completed_at: fresh?.completed_at ?? null,
      credits_added: fresh?.credits_added ?? row.credits_added,
    });
  }

  return NextResponse.json({
    ok: true,
    status: row.status,
    completed_at: row.completed_at,
    credits_added: row.credits_added,
  });
}
