import { serviceClient } from "./supabase/service";
import { getPaymentStatus } from "./coinpay";
import { sendPurchaseReceiptEmail } from "./email";
import { env } from "./env";
import { findPack } from "./credits";

// CoinPay status / event vocabulary that maps to our local state machine.
// Both the webhook and the polling endpoint reference these sets so a single
// rename in the upstream API only needs editing here.
export const COMPLETE_EVENTS = new Set([
  "payment.completed",
  "payment.confirmed",
  "payment.forwarded", // crypto path — fires once funds are sent to merchant wallet
  "payment.paid",
  "payment.succeeded",
]);
export const COMPLETE_STATUSES = new Set([
  "completed",
  "confirmed",
  "forwarded",
  "paid",
  "succeeded",
]);
export const FAIL_EVENTS = new Set([
  "payment.failed",
  "payment.expired",
  "payment.cancelled",
]);
export const FAIL_STATUSES = new Set([
  "failed",
  "expired",
  "cancelled",
  "canceled",
]);

export function classifyCoinpayStatus(
  status: string | null | undefined,
): "complete" | "failed" | "pending" {
  const s = (status ?? "").toLowerCase();
  if (COMPLETE_STATUSES.has(s)) return "complete";
  if (FAIL_STATUSES.has(s)) return "failed";
  return "pending";
}

type SvcClient = ReturnType<typeof serviceClient>;

// Mark a CoinPay purchase complete and email a PDF receipt. Idempotent —
// safe to call from both the webhook and the polling endpoint, and re-runs
// won't double-credit (the SQL RPC short-circuits on already-complete rows)
// or double-email (receipt_emailed_at gate).
export async function completePurchase(input: {
  svc: SvcClient;
  paymentId: string;
  event: Record<string, unknown>;
  txHash?: string | null;
}): Promise<void> {
  const { svc, paymentId, event, txHash } = input;

  const { error } = await svc.rpc("credit_purchase_complete", {
    p_payment_id: paymentId,
    p_event: event,
  });
  if (error) {
    console.error("[coinpay] credit_purchase_complete failed", error);
    throw new Error(error.message);
  }

  try {
    await mailReceipt(svc, paymentId, txHash ?? null);
  } catch (err) {
    // Receipt is best-effort. Credits are already granted; never fail
    // upstream callers (webhook retries / poll loops) on a mail glitch.
    console.error("[coinpay] receipt mail failed", err);
  }
}

export async function failPurchase(input: {
  svc: SvcClient;
  paymentId: string;
  event: Record<string, unknown>;
}): Promise<void> {
  const { svc, paymentId, event } = input;
  await svc
    .from("credit_purchases")
    .update({ status: "failed", coinpay_event: event })
    .eq("coinpay_payment_id", paymentId);
}

// Polling-endpoint entrypoint: if local DB still says pending, ask CoinPay
// directly and reconcile. Returns the final local status.
export async function reconcileFromCoinpay(input: {
  paymentId: string;
}): Promise<"complete" | "failed" | "pending" | "not_found"> {
  const svc = serviceClient();
  const { data: row } = await svc
    .from("credit_purchases")
    .select("status, coinpay_payment_id")
    .eq("coinpay_payment_id", input.paymentId)
    .maybeSingle();
  if (!row) return "not_found";
  if (row.status === "complete" || row.status === "failed") {
    return row.status as "complete" | "failed";
  }

  const remote = await getPaymentStatus(input.paymentId);
  if (!remote) return "pending";

  const classified = classifyCoinpayStatus(remote.status);
  if (classified === "complete") {
    await completePurchase({
      svc,
      paymentId: input.paymentId,
      event: { source: "poll_fallback", remote },
      txHash: remote.txHash,
    });
    return "complete";
  }
  if (classified === "failed") {
    await failPurchase({
      svc,
      paymentId: input.paymentId,
      event: { source: "poll_fallback", remote },
    });
    return "failed";
  }
  return "pending";
}

async function mailReceipt(
  svc: SvcClient,
  paymentId: string,
  txHash: string | null,
): Promise<void> {
  const { data: purchase, error } = await svc
    .from("credit_purchases")
    .select(
      "id, owner_id, pack_id, credits_added, amount_cents, currency, completed_at, receipt_emailed_at",
    )
    .eq("coinpay_payment_id", paymentId)
    .maybeSingle();
  if (error || !purchase) return;
  if (purchase.receipt_emailed_at) return;

  const { data: profile } = await svc
    .from("profiles")
    .select("email")
    .eq("id", purchase.owner_id)
    .maybeSingle();
  let to = profile?.email as string | null | undefined;
  if (!to) {
    const { data: userRes } = await svc.auth.admin.getUserById(
      purchase.owner_id as string,
    );
    to = userRes?.user?.email ?? null;
  }
  if (!to) return;

  if (!env.workerUrl || !env.workerSecret) return;

  const pack = findPack(purchase.pack_id as string);
  const packLabel = pack?.label ?? purchase.pack_id;
  const completedAt = purchase.completed_at ?? new Date().toISOString();
  const amount = `$${(purchase.amount_cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: purchase.amount_cents % 100 === 0 ? 0 : 2,
  })}`;
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
  if (!workerRes.ok) return;
  const pdf = Buffer.from(await workerRes.arrayBuffer());

  const { sent } = await sendPurchaseReceiptEmail({
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
  if (!sent) return;

  await svc
    .from("credit_purchases")
    .update({ receipt_emailed_at: new Date().toISOString() })
    .eq("id", purchase.id);
}
