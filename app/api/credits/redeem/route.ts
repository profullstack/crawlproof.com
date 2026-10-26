// POST /api/credits/redeem { code } — redeem a credit code into scan credits.
// Session cookie or `Authorization: Bearer crp_…`.

import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { redeemCreditCode } from "@/lib/creditCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) return NextResponse.json({ error: "Enter a code.", reason: "invalid" }, { status: 400 });

  const r = await redeemCreditCode(who.user.id, code);
  if (!r.ok) return NextResponse.json({ error: r.message, reason: r.reason }, { status: 400 });
  return NextResponse.json({
    ok: true,
    credits: r.credits,
    balance: r.balance,
    message: `Code redeemed: ${r.credits} credits added.`,
  });
}
