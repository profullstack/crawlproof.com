// Clicks, attributions and conversions on the program we run.
//
// The chain is: a navigation with ?oa= → affiliate_clicks + the `oa` cookie
// (click route) → affiliate_attributions when the user signs in or starts a
// purchase (attributeUser) → affiliate_conversions when the purchase
// completes (recordPurchaseConversion, from the CoinPay webhook, which has no
// cookie and reads the attribution instead) → approved when the hold passes
// (approveDue, from the cron) → paid by lib/affiliate/payouts.ts.

import crypto from "node:crypto";
import { serviceClient } from "../supabase/service";
import { env } from "../env";
import { decodeCookie, expiresAt, withinWindow } from "./cookie";
import { HOLD_DAYS, WINDOW_DAYS } from "./program";
import { commissionCents } from "./spec";
import { membershipByCode, membershipById, type Membership } from "./memberships";
import { queueEvent } from "./webhooks";

type Svc = ReturnType<typeof serviceClient>;

export function ipHash(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash("sha256").update(`${ip}${env.ipHashSalt}`).digest("hex").slice(0, 32);
}

export async function recordClick(input: {
  membership: Membership;
  landing: string | null;
  referrer: string | null;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  await serviceClient().from("affiliate_clicks").insert({
    membership_id: input.membership.id,
    landing: input.landing?.slice(0, 500) ?? null,
    referrer: input.referrer?.slice(0, 500) ?? null,
    ip_hash: ipHash(input.ip),
    user_agent: input.userAgent?.slice(0, 300) ?? null,
  });
}

/**
 * Bind a signed-in user to the affiliate in their cookie. Last-touch: a newer
 * click replaces an older attribution while both are inside the window. The
 * affiliate's own account is never attributed to itself.
 */
export async function attributeUser(userId: string, cookieValue: string | null | undefined): Promise<Membership | null> {
  const parsed = decodeCookie(cookieValue);
  if (!parsed) return null;
  if (!withinWindow(parsed.clickedAt, WINDOW_DAYS)) return null;
  const membership = await membershipByCode(parsed.code);
  if (!membership || membership.status !== "active") return null;
  if (membership.ownerId === userId) return null;

  const svc = serviceClient();
  const { data: current } = await svc
    .from("affiliate_attributions")
    .select("clicked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (current && new Date(current.clicked_at).getTime() >= parsed.clickedAt.getTime()) return membership;

  await svc.from("affiliate_attributions").upsert(
    {
      user_id: userId,
      membership_id: membership.id,
      code: membership.code,
      clicked_at: parsed.clickedAt.toISOString(),
      expires_at: expiresAt(parsed.clickedAt, WINDOW_DAYS).toISOString(),
      set_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  return membership;
}

export async function attributionFor(svc: Svc, userId: string): Promise<{ membershipId: string; code: string; clickedAt: string; expiresAt: string } | null> {
  const { data } = await svc
    .from("affiliate_attributions")
    .select("membership_id, code, clicked_at, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return { membershipId: data.membership_id, code: data.code, clickedAt: data.clicked_at, expiresAt: data.expires_at };
}

/**
 * Record the conversion for a completed credits purchase, if its buyer is
 * attributed to an affiliate. Idempotent on (event, order_ref). Best-effort
 * from the caller's point of view: it never throws, because a purchase must
 * complete whether or not the affiliate row lands.
 */
export async function recordPurchaseConversion(svc: Svc, paymentId: string): Promise<{ recorded: boolean; reason?: string }> {
  try {
    const { data: purchase } = await svc
      .from("credit_purchases")
      .select("id, owner_id, amount_cents, status, completed_at")
      .eq("coinpay_payment_id", paymentId)
      .maybeSingle();
    if (!purchase || purchase.status !== "complete") return { recorded: false, reason: "not complete" };

    const attribution = await attributionFor(svc, purchase.owner_id);
    if (!attribution) return { recorded: false, reason: "no attribution" };
    const completedAt = new Date(purchase.completed_at ?? Date.now());
    if (completedAt.getTime() > new Date(attribution.expiresAt).getTime()) return { recorded: false, reason: "window closed" };

    const membership = await membershipById(attribution.membershipId);
    if (!membership || membership.status !== "active") return { recorded: false, reason: "membership inactive" };

    const self = membership.ownerId === purchase.owner_id;
    const commission = self ? 0 : commissionCents(membership.terms, "sale", purchase.amount_cents);
    const now = new Date();
    const row = {
      membership_id: membership.id,
      event: "sale",
      order_ref: purchase.id,
      customer_id: purchase.owner_id,
      amount_cents: purchase.amount_cents,
      commission_cents: commission,
      status: self ? "reversed" : "pending",
      reason: self ? "self-purchase: the program pays nothing on the affiliate's own account" : null,
      held_until: self ? null : new Date(now.getTime() + HOLD_DAYS * 86_400_000).toISOString(),
    };
    const { data, error } = await svc
      .from("affiliate_conversions")
      .upsert(row, { onConflict: "event,order_ref", ignoreDuplicates: true })
      .select("id, created_at")
      .maybeSingle();
    if (error) {
      console.error("[affiliate] conversion insert failed", error);
      return { recorded: false, reason: error.message };
    }
    if (!data) return { recorded: false, reason: "already recorded" };

    await queueEvent(membership, "conversion.recorded", {
      conversion: {
        id: data.id,
        event: "sale",
        amount: purchase.amount_cents / 100,
        commission: commission / 100,
        status: row.status,
        ...(row.held_until ? { held_until: row.held_until } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      },
    });
    return { recorded: true };
  } catch (err) {
    console.error("[affiliate] recordPurchaseConversion", err);
    return { recorded: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Approve every pending conversion past its hold, unless the purchase was
 * refunded in the meantime, in which case it is reversed with that reason.
 */
export async function approveDue(svc: Svc, now = new Date()): Promise<{ approved: number; reversed: number }> {
  const { data: due } = await svc
    .from("affiliate_conversions")
    .select("id, membership_id, order_ref, amount_cents, commission_cents, event")
    .eq("status", "pending")
    .lte("held_until", now.toISOString())
    .limit(500);
  let approved = 0;
  let reversed = 0;
  for (const c of (due ?? []) as Array<{ id: string; membership_id: string; order_ref: string; amount_cents: number; commission_cents: number; event: string }>) {
    const { data: purchase } = await svc.from("credit_purchases").select("status").eq("id", c.order_ref).maybeSingle();
    const refunded = purchase?.status === "refunded" || purchase?.status === "failed";
    const patch = refunded
      ? { status: "reversed", reason: `refunded ${now.toISOString().slice(0, 10)}`, updated_at: now.toISOString() }
      : { status: "approved", updated_at: now.toISOString() };
    const { error } = await svc.from("affiliate_conversions").update(patch).eq("id", c.id).eq("status", "pending");
    if (error) continue;
    refunded ? reversed++ : approved++;
    const membership = await membershipById(c.membership_id);
    if (membership) {
      await queueEvent(membership, refunded ? "conversion.reversed" : "conversion.approved", {
        conversion: {
          id: c.id,
          event: c.event,
          amount: c.amount_cents / 100,
          commission: c.commission_cents / 100,
          status: patch.status,
          ...("reason" in patch ? { reason: patch.reason } : {}),
        },
      });
    }
  }
  return { approved, reversed };
}

/** Take a conversion back, with the reason the spec requires. */
export async function reverseConversion(svc: Svc, conversionId: string, reason: string): Promise<boolean> {
  const why = reason.trim();
  if (!why) throw new Error("A reversal needs a reason.");
  const { data } = await svc
    .from("affiliate_conversions")
    .update({ status: "reversed", reason: why, updated_at: new Date().toISOString() })
    .eq("id", conversionId)
    .in("status", ["pending", "approved"])
    .select("id, membership_id, event, amount_cents, commission_cents")
    .maybeSingle();
  if (!data) return false;
  const membership = await membershipById(data.membership_id);
  if (membership) {
    await queueEvent(membership, "conversion.reversed", {
      conversion: { id: data.id, event: data.event, amount: data.amount_cents / 100, commission: data.commission_cents / 100, status: "reversed", reason: why },
    });
  }
  return true;
}
