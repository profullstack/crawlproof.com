import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { isAdsPartner } from "@/lib/ads/deposits";
import { parseGrantRequest } from "@/lib/ads/grants";
import { CREDIT_CENTS } from "@/lib/ads/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notPartner = () =>
  NextResponse.json({ error: "Ad credit grants are for partner accounts." }, { status: 403 });

// POST /api/ads/v1/grants {amount_usd, reference}: spend-only ad credit on the
// partner account (ad_bonus_credits). Idempotent on reference: a repeat answers
// applied:false and grants nothing. See lib/ads/grants.ts.
export async function POST(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!isAdsPartner(auth.userId)) return notPartner();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = parseGrantRequest(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data, error } = await serviceClient().rpc("ad_partner_grant", {
    p_partner: auth.userId,
    p_reference: parsed.request.reference,
    p_credits: parsed.request.credits,
  });
  if (error) return NextResponse.json({ error: "Could not record the grant." }, { status: 500 });
  const r = (data ?? {}) as { applied?: boolean; credits?: number; ad_bonus_credits?: number };
  const credits = Number(r.credits ?? parsed.request.credits);
  return NextResponse.json(
    {
      reference: parsed.request.reference,
      applied: Boolean(r.applied),
      credits,
      amount_usd: (credits * CREDIT_CENTS) / 100,
      ad_bonus_credits: Number(r.ad_bonus_credits ?? 0),
      spend_only: true,
    },
    { status: r.applied ? 201 : 200 },
  );
}

// GET /api/ads/v1/grants: the partner's grants, newest first.
export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!isAdsPartner(auth.userId)) return notPartner();
  const { data, error } = await serviceClient()
    .from("ad_partner_grants")
    .select("reference, credits, created_at")
    .eq("partner_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "Could not read grants." }, { status: 500 });
  return NextResponse.json({
    grants: (data ?? []).map((g) => ({ reference: g.reference, credits: g.credits, amount_usd: (g.credits * CREDIT_CENTS) / 100, created_at: g.created_at })),
  });
}
