"use server";

import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { findPack } from "@/lib/credits";
import { creditsDescription, openPurchaseCheckout } from "@/lib/credits-checkout";

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

  // Pre-create the purchase row; the webhook matches it by checkout session id.
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
    const session = await openPurchaseCheckout({
      sb: svc,
      purchaseId: purchase.id,
      userId: user.id,
      email: user.email,
      packId: pack.id,
      credits: pack.credits,
      amountCents: pack.amountCents,
      description: creditsDescription(pack.credits),
      kind: "credits",
    });
    return { ok: true, url: session.url };
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
