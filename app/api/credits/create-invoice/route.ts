import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { findPack } from "@/lib/credits";
import { createPayment } from "@/lib/coinpay";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const Body = z.object({
  packId: z.string().min(1),
  currency: z.string().min(1).max(20),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { packId, currency } = parsed.data;

  const pack = findPack(packId);
  if (!pack) return NextResponse.json({ ok: false, error: "Unknown pack." }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const svc = serviceClient();
  const { data: purchase, error: insertErr } = await svc
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
  if (insertErr || !purchase) {
    return NextResponse.json(
      { ok: false, error: insertErr?.message ?? "Could not create purchase." },
      { status: 500 },
    );
  }

  try {
    const payment = await createPayment({
      packId: pack.id,
      credits: pack.credits,
      amountCents: pack.amountCents,
      ownerId: user.id,
      ownerEmail: user.email ?? null,
      currency: currency.toLowerCase(),
      successUrl: `${env.siteUrl}/dashboard/settings/billing?purchase=success`,
      cancelUrl: `${env.siteUrl}/dashboard/settings/billing?purchase=cancel`,
      webhookUrl: `${env.siteUrl}/api/coinpay/webhook`,
      metadata: { purchase_id: purchase.id },
    });

    await svc
      .from("credit_purchases")
      .update({ coinpay_payment_id: payment.paymentId })
      .eq("id", purchase.id);

    return NextResponse.json({
      ok: true,
      payment_id: payment.paymentId,
      address: payment.address,
      amount_crypto: payment.amountCrypto,
      currency: payment.currency,
      expires_at: payment.expiresAt,
      checkout_url: payment.hostedUrl,
      is_card: currency.toLowerCase() === "card",
    });
  } catch (err) {
    await svc.from("credit_purchases").update({ status: "failed" }).eq("id", purchase.id);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "CoinPay error." },
      { status: 502 },
    );
  }
}
