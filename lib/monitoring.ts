// Paid weekly monitoring (R3 of the 30-day validation test).
//
// Two plans: Solo ($49/mo, 1 site) and Agency ($199/mo, up to 20 sites).
//
// Payment: a CoinPay hosted checkout session per month (any coin, or a card
// through PayPal guest checkout). There is no Stripe and no card on file
// (standing rule), so nothing renews by itself: a month is bought, and five
// days before it runs out the subscriber is emailed a link to buy the next.
// A period that ends unpaid (plus a short grace) stops the re-scans.
//
// Monitoring itself is the existing scan_watches machinery: each site on a
// subscription is a watch that is pre-verified (paying is the opt-in), runs
// weekly on the rule engine, and emails when the score moves. The watch's
// subscription_id ties its life to the subscription's.

import crypto from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";
import { createCheckoutSession, getCheckoutSession, type CoinpayWebhookEvent } from "@/lib/coinpay";
import { isAllowedTargetUrl } from "@/lib/rateLimit";
import { newShareToken } from "@/lib/shareToken";
import { sendMonitorRenewalEmail } from "@/lib/email";
import { recordFunnelEvent, type FunnelSource } from "@/lib/funnel";
import { env } from "@/lib/env";

export const MONITOR_PLANS = {
  solo: { id: "solo", label: "Solo", amountCents: 4900, siteLimit: 1, blurb: "One site, re-scanned every week." },
  agency: { id: "agency", label: "Agency", amountCents: 19900, siteLimit: 20, blurb: "Up to 20 client sites, re-scanned every week." },
} as const;
export type MonitorPlanId = keyof typeof MONITOR_PLANS;

export const PERIOD_DAYS = 30;
export const RENEWAL_NOTICE_DAYS = 5;
export const GRACE_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

export function isMonitorPlan(v: unknown): v is MonitorPlanId {
  return v === "solo" || v === "agency";
}

export function priceLabel(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export type MonitorSubscription = {
  id: string;
  owner_id: string;
  email: string;
  plan: MonitorPlanId;
  site_limit: number;
  status: "pending" | "active" | "canceled" | "expired";
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  funnel_source: FunnelSource;
  origin_audit_id: string | null;
  renewal_notified_at: string | null;
};

/**
 * End of the period a payment buys. Paying early extends from the current
 * end, so a renewal never loses the days left; paying after a lapse starts
 * from now. Pure.
 */
export function nextPeriodEnd(currentEnd: string | null, now: Date): Date {
  const end = currentEnd ? Date.parse(currentEnd) : NaN;
  const base = Number.isFinite(end) && end > now.getTime() ? end : now.getTime();
  return new Date(base + PERIOD_DAYS * DAY);
}

/** What the daily sweep should do with one subscription. Pure. */
export function sweepAction(
  sub: Pick<MonitorSubscription, "status" | "current_period_end" | "cancel_at_period_end" | "renewal_notified_at">,
  now: Date,
): "none" | "remind" | "end" {
  if (sub.status !== "active" || !sub.current_period_end) return "none";
  const end = Date.parse(sub.current_period_end);
  if (!Number.isFinite(end)) return "none";
  const t = now.getTime();
  // A cancelled subscription simply runs out at the end of what was paid.
  if (sub.cancel_at_period_end) return t >= end ? "end" : "none";
  if (t >= end + GRACE_DAYS * DAY) return "end";
  if (t >= end - RENEWAL_NOTICE_DAYS * DAY) {
    const notified = sub.renewal_notified_at ? Date.parse(sub.renewal_notified_at) : NaN;
    // One reminder per period: anything sent inside this period's notice window counts.
    if (Number.isFinite(notified) && notified >= end - RENEWAL_NOTICE_DAYS * DAY) return "none";
    return "remind";
  }
  return "none";
}

type Svc = ReturnType<typeof serviceClient>;

export function siteBase(): string {
  return (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");
}

/**
 * Open a checkout for a new subscription or the next month of an existing one.
 * Records checkout_started. Returns the CoinPay URL to send the buyer to.
 */
export async function openMonitorCheckout(input: {
  userId: string;
  email: string;
  plan: MonitorPlanId;
  subscriptionId?: string | null;
  originToken?: string | null;
  source: FunnelSource;
  visitorId: string | null;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const svc = serviceClient();
  const plan = MONITOR_PLANS[input.plan];

  let sub: MonitorSubscription | null = null;
  if (input.subscriptionId) {
    const { data } = await svc
      .from("monitor_subscriptions")
      .select("*")
      .eq("id", input.subscriptionId)
      .eq("owner_id", input.userId)
      .maybeSingle();
    sub = (data as MonitorSubscription | null) ?? null;
    if (!sub) return { ok: false, error: "Subscription not found." };
  } else {
    let originAuditId: string | null = null;
    if (input.originToken) {
      const { data: audit } = await svc
        .from("audits")
        .select("id")
        .eq("share_token", input.originToken)
        .maybeSingle();
      originAuditId = (audit?.id as string | undefined) ?? null;
    }
    // Reuse an unpaid subscription for the same plan rather than stacking rows
    // every time somebody opens checkout and backs out.
    const { data: open } = await svc
      .from("monitor_subscriptions")
      .select("*")
      .eq("owner_id", input.userId)
      .eq("plan", plan.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (open) {
      sub = open as MonitorSubscription;
      if (originAuditId && !sub.origin_audit_id) {
        await svc.from("monitor_subscriptions").update({ origin_audit_id: originAuditId }).eq("id", sub.id);
      }
    } else {
      const { data: created, error } = await svc
        .from("monitor_subscriptions")
        .insert({
          owner_id: input.userId,
          email: input.email,
          plan: plan.id,
          site_limit: plan.siteLimit,
          status: "pending",
          funnel_source: input.source,
          origin_audit_id: originAuditId,
        })
        .select("*")
        .single();
      if (error || !created) return { ok: false, error: error?.message ?? "Could not start the subscription." };
      sub = created as MonitorSubscription;
    }
  }

  const amountCents = MONITOR_PLANS[sub.plan].amountCents;
  const { data: payment, error: payErr } = await svc
    .from("monitor_payments")
    .insert({ subscription_id: sub.id, amount_cents: amountCents, status: "pending" })
    .select("id")
    .single();
  if (payErr || !payment) return { ok: false, error: payErr?.message ?? "Could not start checkout." };

  const base = siteBase();
  try {
    const session = await createCheckoutSession({
      amountCents,
      description: `CrawlProof ${MONITOR_PLANS[sub.plan].label} weekly monitoring, 30 days`,
      customerEmail: input.email,
      accountId: input.userId,
      metadata: {
        kind: "monitor",
        subscription_id: sub.id,
        monitor_payment_id: payment.id as string,
        plan: sub.plan,
        owner_id: input.userId,
        customer_email: input.email,
      },
      successUrl: `${base}/dashboard/monitoring?paid=1`,
      cancelUrl: `${base}/dashboard/monitoring?canceled=1`,
    });
    await svc.from("monitor_payments").update({ coinpay_session_id: session.sessionId }).eq("id", payment.id);
    await recordFunnelEvent({
      event: "checkout_started",
      source: sub.funnel_source ?? input.source,
      visitorId: input.visitorId,
      userId: input.userId,
      auditId: sub.origin_audit_id,
      meta: { plan: sub.plan, renewal: !!input.subscriptionId },
    });
    return { ok: true, url: session.url };
  } catch (err) {
    await svc.from("monitor_payments").update({ status: "failed" }).eq("id", payment.id);
    return { ok: false, error: err instanceof Error ? err.message : "CoinPay error." };
  }
}

function newWatchSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Put one site on a subscription: create or take over the matching watch, pre-verified, weekly. */
export async function addMonitorSite(
  svc: Svc,
  sub: Pick<MonitorSubscription, "id" | "email" | "site_limit">,
  rawUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const check = isAllowedTargetUrl(rawUrl);
  if (!check.ok) return { ok: false, error: check.reason };
  const target = check.url;

  const { data: current } = await svc
    .from("scan_watches")
    .select("id, target_url")
    .eq("subscription_id", sub.id)
    .is("unsubscribed_at", null);
  const sites = (current ?? []) as { id: string; target_url: string }[];
  if (sites.some((s) => s.target_url === target)) return { ok: true };
  if (sites.length >= sub.site_limit) {
    return { ok: false, error: `Your plan covers ${sub.site_limit} site${sub.site_limit === 1 ? "" : "s"}. Remove one first.` };
  }

  const now = new Date().toISOString();
  const { data: existing } = await svc
    .from("scan_watches")
    .select("id")
    .ilike("email", sub.email.trim())
    .eq("target_url", target)
    .eq("engine", "rule")
    .maybeSingle();
  const fields = {
    subscription_id: sub.id,
    verified_at: now,
    unsubscribed_at: null,
    cadence: "weekly",
    next_run_at: now,
  };
  const { error } = existing
    ? await svc.from("scan_watches").update(fields).eq("id", existing.id)
    : await svc.from("scan_watches").insert({
        ...fields,
        email: sub.email.trim().toLowerCase(),
        target_url: target,
        engine: "rule",
        confirm_token: newShareToken(),
        unsubscribe_token: newWatchSecret(),
      });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function removeMonitorSite(svc: Svc, subscriptionId: string, watchId: string): Promise<void> {
  await svc
    .from("scan_watches")
    .update({ subscription_id: null, unsubscribed_at: new Date().toISOString() })
    .eq("id", watchId)
    .eq("subscription_id", subscriptionId);
}

/**
 * Settle a paid monitoring month. Idempotent: the payment row flips from
 * pending to complete exactly once, and only that call extends the period.
 */
export async function completeMonitorPayment(
  svc: Svc,
  paymentId: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  const now = new Date();
  const { data: flipped } = await svc
    .from("monitor_payments")
    .update({ status: "complete", completed_at: now.toISOString(), event })
    .eq("id", paymentId)
    .eq("status", "pending")
    .select("subscription_id")
    .maybeSingle();
  if (!flipped) return false; // already settled (or unknown)

  const { data: subRow } = await svc
    .from("monitor_subscriptions")
    .select("*")
    .eq("id", flipped.subscription_id)
    .maybeSingle();
  const sub = subRow as MonitorSubscription | null;
  if (!sub) return false;

  const firstPayment = sub.status === "pending";
  const periodEnd = nextPeriodEnd(sub.status === "active" ? sub.current_period_end : null, now);
  await svc
    .from("monitor_subscriptions")
    .update({
      status: "active",
      current_period_end: periodEnd.toISOString(),
      cancel_at_period_end: false,
      renewal_notified_at: null,
    })
    .eq("id", sub.id);
  await svc.from("monitor_payments").update({ period_end: periodEnd.toISOString() }).eq("id", paymentId);

  // Bring the sites (back) on: the ones this subscription already had, or on
  // the first payment the site whose report the subscriber came from.
  const { data: paused } = await svc
    .from("scan_watches")
    .select("id")
    .eq("subscription_id", sub.id);
  if ((paused ?? []).length > 0) {
    await svc
      .from("scan_watches")
      .update({ unsubscribed_at: null, verified_at: now.toISOString() })
      .eq("subscription_id", sub.id);
  } else if (sub.origin_audit_id) {
    const { data: audit } = await svc
      .from("audits")
      .select("target_url")
      .eq("id", sub.origin_audit_id)
      .maybeSingle();
    if (audit?.target_url) await addMonitorSite(svc, sub, audit.target_url as string);
  }

  if (firstPayment) {
    await recordFunnelEvent({
      event: "subscribed",
      source: sub.funnel_source,
      userId: sub.owner_id,
      auditId: sub.origin_audit_id,
      meta: { plan: sub.plan },
    });
  }
  return true;
}

/**
 * Webhook hook: answers true when the event belongs to a monitoring payment
 * (and has been handled), false when it is somebody else's.
 */
export async function handleMonitorWebhook(
  svc: Svc,
  evt: CoinpayWebhookEvent,
  payload: Record<string, unknown>,
  outcome: "complete" | "fail",
): Promise<boolean> {
  const metaId = typeof evt.metadata.monitor_payment_id === "string" ? evt.metadata.monitor_payment_id : null;
  let paymentId: string | null = null;
  if (evt.sessionId) {
    const { data } = await svc
      .from("monitor_payments")
      .select("id")
      .eq("coinpay_session_id", evt.sessionId)
      .maybeSingle();
    paymentId = (data?.id as string | undefined) ?? null;
  }
  if (!paymentId && metaId && /^[0-9a-f-]{36}$/i.test(metaId)) {
    const { data } = await svc.from("monitor_payments").select("id").eq("id", metaId).maybeSingle();
    paymentId = (data?.id as string | undefined) ?? null;
  }
  if (!paymentId) return false;
  // One coin attempt failing does not end a session: the buyer can pick
  // another coin or PayPal. Session expiry is left to the reconcile poll.
  if (outcome === "complete") await completeMonitorPayment(svc, paymentId, payload);
  return true;
}

/** Return-from-checkout fallback when the webhook is slow: ask CoinPay directly. */
export async function reconcilePendingMonitorPayments(svc: Svc, ownerId: string): Promise<void> {
  const { data: subs } = await svc.from("monitor_subscriptions").select("id").eq("owner_id", ownerId);
  const ids = ((subs ?? []) as { id: string }[]).map((s) => s.id);
  if (ids.length === 0) return;
  const since = new Date(Date.now() - 2 * DAY).toISOString();
  const { data: pending } = await svc
    .from("monitor_payments")
    .select("id, coinpay_session_id")
    .in("subscription_id", ids)
    .eq("status", "pending")
    .gte("created_at", since)
    .not("coinpay_session_id", "is", null);
  for (const p of (pending ?? []) as { id: string; coinpay_session_id: string }[]) {
    const session = await getCheckoutSession(p.coinpay_session_id).catch(() => null);
    if (!session) continue;
    if (session.status === "paid") {
      await completeMonitorPayment(svc, p.id, { source: "poll_fallback", session });
    } else if (session.status === "expired") {
      await svc.from("monitor_payments").update({ status: "failed" }).eq("id", p.id).eq("status", "pending");
    }
  }
}

/** Daily-ish sweep, run from the scan-watches cron: renewal reminders and lapses. */
export async function sweepMonitorSubscriptions(svc: Svc, now = new Date()): Promise<{ reminded: number; ended: number }> {
  const { data } = await svc
    .from("monitor_subscriptions")
    .select("*")
    .eq("status", "active")
    .lt("current_period_end", new Date(now.getTime() + RENEWAL_NOTICE_DAYS * DAY).toISOString())
    .limit(200);
  let reminded = 0;
  let ended = 0;
  const renewUrl = `${siteBase()}/dashboard/monitoring`;
  for (const sub of (data ?? []) as MonitorSubscription[]) {
    const action = sweepAction(sub, now);
    const plan = MONITOR_PLANS[sub.plan];
    if (action === "remind") {
      const res = await sendMonitorRenewalEmail({
        to: sub.email,
        planLabel: plan.label,
        amountLabel: priceLabel(plan.amountCents),
        periodEnd: sub.current_period_end!,
        renewUrl,
        lapsed: false,
      });
      if (res.sent) {
        await svc.from("monitor_subscriptions").update({ renewal_notified_at: now.toISOString() }).eq("id", sub.id);
        reminded++;
      }
    } else if (action === "end") {
      await svc
        .from("monitor_subscriptions")
        .update({ status: sub.cancel_at_period_end ? "canceled" : "expired" })
        .eq("id", sub.id);
      await svc
        .from("scan_watches")
        .update({ unsubscribed_at: now.toISOString(), pending_audit_id: null })
        .eq("subscription_id", sub.id)
        .is("unsubscribed_at", null);
      if (!sub.cancel_at_period_end) {
        await sendMonitorRenewalEmail({
          to: sub.email,
          planLabel: plan.label,
          amountLabel: priceLabel(plan.amountCents),
          periodEnd: sub.current_period_end!,
          renewUrl,
          lapsed: true,
        });
      }
      ended++;
    }
  }
  return { reminded, ended };
}
