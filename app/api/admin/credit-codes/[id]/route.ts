// DELETE /api/admin/credit-codes/<id> — revoke a code (admin only).

import { NextResponse, type NextRequest } from "next/server";
import { getCreditDeps } from "@/lib/creditCodes";
import { requireAdmin } from "@/lib/requireAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  const { id } = await ctx.params;
  try {
    await getCreditDeps().credits.revoke(id);
  } catch {
    return NextResponse.json({ error: "Code not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
