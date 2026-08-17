"use server";

import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { findPack } from "@/lib/credits";
import { createCheckout } from "@/lib/coinpay";
import { env } from "@/lib/env";

export async function startCreditPurchase(input: {
  packId: string;
}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const pack = findPack(input.packId);
  if (!pack) return { ok: false, error: "Unknown pack." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Pre-create the purchase row so the webhook can match by payment_id later.
  const svc = serviceClient();
  const { data: purchase, error } = await svc
    .from("credit_purchases")
    .insert({
      owner_id: user.id,
      pack_id: pack.id,
      credits_added: pack.credits,
      amount_cents: pack.amountCents,
      currency: "USD",
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !purchase) {
    return { ok: false, error: error?.message ?? "Could not create purchase." };
  }

  try {
    const checkout = await createCheckout({
      packId: pack.id,
      credits: pack.credits,
      amountCents: pack.amountCents,
      ownerId: user.id,
      ownerEmail: user.email ?? null,
      successUrl: `${env.siteUrl}/dashboard/settings/billing?purchase=success`,
      cancelUrl: `${env.siteUrl}/dashboard/settings/billing?purchase=cancel`,
      webhookUrl: `${env.siteUrl}/api/coinpay/webhook`,
      metadata: { purchase_id: purchase.id },
    });

    // Store the CoinPay payment id on the row so the webhook can find it.
    await svc
      .from("credit_purchases")
      .update({ coinpay_payment_id: checkout.paymentId })
      .eq("id", purchase.id);

    return { ok: true, url: checkout.hostedUrl };
  } catch (err) {
    await svc
      .from("credit_purchases")
      .update({ status: "failed" })
      .eq("id", purchase.id);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "CoinPay error.",
    };
  }
}
