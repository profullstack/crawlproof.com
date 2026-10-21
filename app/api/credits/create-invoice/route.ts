import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { findPack } from "@/lib/credits";
import { creditsDescription, openPurchaseCheckout } from "@/lib/credits-checkout";
import { attributeUser } from "@/lib/affiliate/attribution";
import { cookieFromHeader } from "@/lib/affiliate/cookie";

export const runtime = "nodejs";

// `currency` is accepted and ignored: older clients sent the coin they picked,
// the buyer now picks it (or PayPal) on CoinPay's hosted checkout page.
const Body = z.object({
  packId: z.string().min(1),
  currency: z.string().max(20).optional(),
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
  const { packId } = parsed.data;

  const pack = findPack(packId);
  if (!pack) return NextResponse.json({ ok: false, error: "Unknown pack." }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  // OpenAffiliate: a buyer carrying the attribution cookie is bound to that
  // affiliate now, so the completion webhook (which has no cookie) can find it.
  try {
    await attributeUser(user.id, cookieFromHeader(req.headers.get("cookie")));
  } catch (err) {
    console.error("[affiliate] attribute at invoice", err);
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

    return NextResponse.json({
      ok: true,
      payment_id: session.sessionId,
      checkout_url: session.url,
      expires_at: session.expiresAt,
    });
  } catch (err) {
    await svc.from("credit_purchases").update({ status: "failed" }).eq("id", purchase.id);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "CoinPay error." },
      { status: 502 },
    );
  }
}
