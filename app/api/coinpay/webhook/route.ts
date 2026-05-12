import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { verifyWebhookSignature } from "@/lib/coinpay";

export const runtime = "nodejs";

// CoinPay webhook receiver.
//
// Expected payload shape (adjust to match real CoinPay events):
//   {
//     "event": "payment.completed" | "payment.failed" | "payment.expired" | ...,
//     "payment_id": "...",
//     "amount_cents": 1000,
//     "currency": "USD",
//     "metadata": { "purchase_id": "...", "owner_id": "...", "credits": "10" }
//   }
//
// Signature is verified via HMAC-SHA256 over the raw body with
// COINPAY_WEBHOOK_SECRET. Returns 200 on processed and 200 on duplicate so
// CoinPay won't retry forever. Returns 401 only on signature failure.

export async function POST(req: Request) {
  const raw = await req.text();
  const sig =
    req.headers.get("x-coinpay-signature") ??
    req.headers.get("coinpay-signature") ??
    null;

  if (!verifyWebhookSignature(raw, sig)) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let payload: {
    event?: string;
    payment_id?: string;
    metadata?: Record<string, string>;
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const paymentId = payload.payment_id;
  if (!paymentId) {
    return NextResponse.json({ ok: false, error: "missing_payment_id" }, { status: 400 });
  }

  const svc = serviceClient();
  const event = (payload.event ?? "").toLowerCase();

  if (event === "payment.completed" || event === "payment.succeeded" || event === "completed") {
    // Idempotent — function does nothing if already complete.
    const { error } = await svc.rpc("credit_purchase_complete", {
      p_payment_id: paymentId,
      p_event: payload as unknown as object,
    });
    if (error) {
      console.error("[coinpay] credit_purchase_complete failed", error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (event === "payment.failed" || event === "payment.expired" || event === "failed") {
    await svc
      .from("credit_purchases")
      .update({ status: "failed", coinpay_event: payload as unknown as object })
      .eq("coinpay_payment_id", paymentId);
    return NextResponse.json({ ok: true });
  }

  // Unknown but signed event — log and ack so it isn't retried.
  console.log("[coinpay] ignored event", event, paymentId);
  return NextResponse.json({ ok: true, ignored: event });
}
