// /api/ads/v1/slots/[id] — one of the caller's publisher slots.
//
//   GET    The slot's status, payout wallet, and what it has earned and can
//          withdraw (cents).
//   PATCH  { payout_address?, payout_currency?, status?: active|paused }
//          An empty payout_address clears the wallet.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { cleanPayoutTarget, slotAvailableCents } from "@/lib/ads/payouts";
import { MIN_PAYOUT_CENTS } from "@/lib/ads/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(userId: string, id: string) {
  if (!UUID.test(id)) return null;
  const sb = serviceClient();
  const { data: slot, error } = await sb
    .from("ad_slots")
    .select("id, placement, status, payout_address, payout_currency")
    .eq("id", id)
    .eq("owner_id", userId)
    .maybeSingle();
  // A failed query is not a missing slot: say so instead of answering 404.
  if (error) throw new Error(error.message);
  if (!slot) return null;
  const { data: accruals } = await sb.from("ad_ledger").select("amount_cents").eq("slot_id", id).eq("kind", "publisher_accrual");
  const earned = (accruals ?? []).reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  return {
    id: slot.id,
    placement: slot.placement,
    status: slot.status,
    payout_address: slot.payout_address,
    payout_currency: slot.payout_currency,
    earned_cents: earned,
    available_cents: await slotAvailableCents(sb, id),
    min_payout_cents: MIN_PAYOUT_CENTS,
  };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const slot = await load(auth.userId, (await ctx.params).id);
  return slot ? NextResponse.json(slot) : NextResponse.json({ error: "No such slot." }, { status: 404 });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  if (!(await load(auth.userId, id))) return NextResponse.json({ error: "No such slot." }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  if ("payout_address" in body || "payout_currency" in body) {
    const t = cleanPayoutTarget(body.payout_address, body.payout_currency);
    if ("payout_address" in body) patch.payout_address = t.address;
    if ("payout_currency" in body) patch.payout_currency = t.currency;
  }
  if ("status" in body) {
    if (body.status !== "active" && body.status !== "paused") return NextResponse.json({ error: "status is active or paused." }, { status: 400 });
    patch.status = body.status;
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  const { error } = await serviceClient().from("ad_slots").update(patch).eq("id", id).eq("owner_id", auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(await load(auth.userId, id));
}
