import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { verifyWebhookSignature } from "@/lib/coinpay";

export const runtime = "nodejs";

// CoinPay webhook receiver.
//
// Verified with HMAC-SHA256 over `${timestamp}.${rawBody}` using
// COINPAY_WEBHOOK_SECRET — header format is the Stripe-style
//   X-CoinPay-Signature: t=<unix>,v1=<hex>
//
// Expected payload envelope:
//   {
//     id: "evt_...",
//     type: "payment.completed" | "payment.failed" | ...,
//     data: { payment_id, status, amount_usd, currency, ... },
//     created_at: ISO8601,
//     business_id: "<merchant id>"
//   }
//
// We respond 200 to any signed event we don't process so CoinPay doesn't
// retry. Signature failures return 401.

type CoinPayEvent = {
  id?: string;
  type?: string;
  created_at?: string;
  business_id?: string;
  data?: {
    payment_id?: string;
    status?: string;
    amount_usd?: string;
    amount_crypto?: string;
    currency?: string;
    tx_hash?: string;
    confirmations?: number;
    [k: string]: unknown;
  };
};

const COMPLETE_EVENTS = new Set([
  "payment.completed",
  "payment.confirmed",
  "payment.paid",
  "payment.succeeded",
]);
const COMPLETE_STATUSES = new Set(["completed", "confirmed", "paid", "succeeded"]);

const FAIL_EVENTS = new Set(["payment.failed", "payment.expired", "payment.cancelled"]);
const FAIL_STATUSES = new Set(["failed", "expired", "cancelled", "canceled"]);

export async function POST(req: Request) {
  const raw = await req.text();
  const sig =
    req.headers.get("x-coinpay-signature") ??
    req.headers.get("coinpay-signature") ??
    null;

  if (!verifyWebhookSignature(raw, sig)) {
    return NextResponse.json({ ok: false, error: "bad_signature" }, { status: 401 });
  }

  let payload: CoinPayEvent;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const eventType = (payload.type ?? "").toLowerCase();

  // Test pings (e.g. type: "test.webhook") — ack and move on.
  if (eventType === "test.webhook" || eventType === "ping") {
    return NextResponse.json({ ok: true, test: true });
  }

  const paymentId = payload.data?.payment_id;
  const status = (payload.data?.status ?? "").toLowerCase();
  if (!paymentId) {
    return NextResponse.json(
      { ok: false, error: "missing_payment_id" },
      { status: 400 },
    );
  }

  const svc = serviceClient();
  const isComplete = COMPLETE_EVENTS.has(eventType) || COMPLETE_STATUSES.has(status);
  const isFail = FAIL_EVENTS.has(eventType) || FAIL_STATUSES.has(status);

  if (isComplete) {
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

  if (isFail) {
    await svc
      .from("credit_purchases")
      .update({ status: "failed", coinpay_event: payload as unknown as object })
      .eq("coinpay_payment_id", paymentId);
    return NextResponse.json({ ok: true });
  }

  // Other signed events (e.g. payment.pending) — ack without state change.
  console.log("[coinpay] ignored event", eventType, status, paymentId);
  return NextResponse.json({ ok: true, ignored: eventType });
}
