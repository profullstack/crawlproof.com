// DELETE /api/invites/<id> — withdraw an unused invite (refunds the slot).

import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { InviteError, revokeInvite } from "@/lib/creditCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { id } = await ctx.params;
  try {
    await revokeInvite(who.user.id, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InviteError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: err.status });
    }
    throw err;
  }
}
