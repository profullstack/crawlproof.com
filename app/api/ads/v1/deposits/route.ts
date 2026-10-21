// /api/ads/v1/deposits — ad budget, bought in crypto, for partner platforms.
//
//   POST { amount_usd, currency? }  A CoinPay invoice for that much ad budget
//        at its ad value ($1 = 20 credits). Answers with the address and exact
//        amount to send; credits land on this account once CoinPay sees it.
//   POST { amount_usd, checkout: "session", customer_email?, account_id?,
//          property?, success_url?, cancel_url?, reference? }
//        A CoinPay hosted checkout session for the partner's own buyer, who
//        picks any coin or PayPal there. Answers { checkout_session_id, url,
//        status: "open", ... }; GET /:checkout_session_id follows it.
//        Partner accounts only (ADS_PARTNER_USER_IDS): see lib/ads/deposits.ts.
//   GET  This account's ad-budget deposits, newest first.
//
// Same bearer auth as /api/ads/v1/campaigns.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { AD_BUDGET_PACK, createAdDeposit, isAdsPartner, parseDepositRequest } from "@/lib/ads/deposits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!isAdsPartner(auth.userId)) {
    return NextResponse.json({ error: "Ad-budget deposits are for partner accounts. Buy credits at https://crawlproof.com/dashboard/settings/billing." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = parseDepositRequest(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const sb = serviceClient();
  const { data: who } = await sb.auth.admin.getUserById(auth.userId);
  const result = await createAdDeposit({
    sb,
    userId: auth.userId,
    email: who?.user?.email ?? null,
    request: parsed.request,
    ...(typeof body.reference === "string" ? { reference: body.reference } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.deposit, { status: 201 });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { data, error } = await serviceClient()
    .from("credit_purchases")
    .select("coinpay_payment_id, amount_cents, credits_added, status, created_at, completed_at")
    .eq("owner_id", auth.userId)
    .eq("pack_id", AD_BUDGET_PACK)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    deposits: (data ?? []).map((r) => ({
      payment_id: r.coinpay_payment_id,
      amount_usd: r.amount_cents / 100,
      credits: r.credits_added,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
    })),
  });
}
