// POST /api/affiliate/v1/joined/:id/sync — read that merchant's ledger now.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { syncJoin } from "@/lib/affiliate/directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const { id } = await ctx.params;
  const out = await syncJoin(id, who.user.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  const j = out.join;
  return NextResponse.json({ join: { id: j.id, origin: j.origin, program: j.programId, status: j.status, ledger: j.ledger, synced_at: j.syncedAt } });
}
