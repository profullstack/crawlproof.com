// Admin: mint and list credit codes.
//   GET  /api/admin/credit-codes                       — every code (never the hash or plaintext)
//   POST /api/admin/credit-codes { credits, label?, max_redemptions?, expires_at? }
//        → { code } shown once; only its sha256 is stored.
// is_admin only, by session cookie or crp_ API token.

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { getCreditDeps, mintCreditCode } from "@/lib/creditCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  return NextResponse.json({ codes: await getCreditDeps().credits.list() });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const expires = body.expires_at ? Date.parse(String(body.expires_at)) : null;
  if (body.expires_at && !Number.isFinite(expires)) {
    return NextResponse.json({ error: "expires_at must be an ISO date." }, { status: 400 });
  }
  try {
    const minted = await mintCreditCode({
      credits: Number(body.credits),
      label: typeof body.label === "string" ? body.label : undefined,
      maxRedemptions: body.max_redemptions === undefined ? 1 : Number(body.max_redemptions),
      expiresAt: expires,
      createdBy: admin.userId,
    });
    return NextResponse.json(minted, { status: 201 });
  } catch (err) {
    if (err instanceof TypeError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
