import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { verifyWebhookSignature } from "@/lib/coinpay";
import { sendPurchaseReceiptEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { findPack } from "@/lib/credits";

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
  "payment.forwarded", // crypto path — fires once funds are sent to merchant wallet
  "payment.paid",
  "payment.succeeded",
]);
const COMPLETE_STATUSES = new Set([
  "completed",
  "confirmed",
  "forwarded",
  "paid",
  "succeeded",
]);

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
    // Mail receipt off-band — it touches the PDF worker + Resend, can take
    // several seconds, and the credits are already granted. Slow handlers
    // ripple upstream: CoinPay awaits our 200 before returning to Stripe,
    // and Stripe times out webhooks at 30s. Returning immediately keeps the
    // chain fast; the promise keeps running on the Node process.
    void mailReceiptIfNeeded(svc, paymentId, payload).catch((err) => {
      console.error("[coinpay] receipt mail failed", err);
    });
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

type SvcClient = ReturnType<typeof serviceClient>;

async function mailReceiptIfNeeded(
  svc: SvcClient,
  paymentId: string,
  event: CoinPayEvent,
): Promise<void> {
  const { data: purchase, error } = await svc
    .from("credit_purchases")
    .select(
      "id, owner_id, pack_id, credits_added, amount_cents, currency, completed_at, receipt_emailed_at",
    )
    .eq("coinpay_payment_id", paymentId)
    .maybeSingle();
  if (error || !purchase) {
    console.warn("[coinpay] receipt: purchase not found", { paymentId, error });
    return;
  }
  if (purchase.receipt_emailed_at) return; // already sent

  const { data: profile } = await svc
    .from("profiles")
    .select("email")
    .eq("id", purchase.owner_id)
    .maybeSingle();
  let to = profile?.email as string | null | undefined;
  if (!to) {
    // Fallback to auth.users.email if the profile row is missing email.
    const { data: userRes } = await svc.auth.admin.getUserById(
      purchase.owner_id as string,
    );
    to = userRes?.user?.email ?? null;
  }
  if (!to) {
    console.warn("[coinpay] receipt: no email for owner", purchase.owner_id);
    return;
  }

  if (!env.workerUrl || !env.workerSecret) {
    console.warn("[coinpay] receipt: worker not configured, skipping PDF");
    return;
  }

  const pack = findPack(purchase.pack_id as string);
  const packLabel = pack?.label ?? purchase.pack_id;
  const completedAt = purchase.completed_at ?? new Date().toISOString();
  const amount = `$${(purchase.amount_cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: purchase.amount_cents % 100 === 0 ? 0 : 2,
  })}`;
  const txHash = event.data?.tx_hash ?? null;
  const txLine = txHash ? `\n**Transaction:** \`${txHash}\`\n` : "";

  const markdown = `# Receipt

Thanks for your purchase! Your credits are ready to use.

|  |  |
|---|---|
| **Order** | \`${paymentId}\` |
| **Date** | ${new Date(completedAt).toUTCString()} |
| **Pack** | ${packLabel} |
| **Credits added** | ${purchase.credits_added} |
| **Total paid** | ${amount} ${purchase.currency} |
| **Payment method** | Crypto (CoinPay) |
${txLine}

Sign in to your CrawlProof dashboard to start a scan. Questions? Just reply to this email.
`;

  const workerRes = await fetch(`${env.workerUrl}/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
    body: JSON.stringify({ markdown, title: "CrawlProof receipt" }),
  });
  if (!workerRes.ok) {
    console.error("[coinpay] receipt: PDF render failed", workerRes.status);
    return;
  }
  const pdf = Buffer.from(await workerRes.arrayBuffer());

  const { sent, error: mailErr } = await sendPurchaseReceiptEmail({
    to,
    paymentId,
    packLabel,
    creditsAdded: purchase.credits_added as number,
    amountCents: purchase.amount_cents as number,
    currency: purchase.currency as string,
    txHash,
    completedAt,
    pdf,
  });
  if (!sent) {
    console.error("[coinpay] receipt: mail failed", mailErr);
    return;
  }

  await svc
    .from("credit_purchases")
    .update({ receipt_emailed_at: new Date().toISOString() })
    .eq("id", purchase.id);
}
