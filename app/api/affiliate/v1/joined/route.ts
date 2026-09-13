// GET /api/affiliate/v1/joined — the programs the caller has joined elsewhere, each with its last ledger read.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { listJoins } from "@/lib/affiliate/directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const joins = await listJoins(who.user.id);
  return NextResponse.json({
    joined: joins.map((j) => ({
      id: j.id,
      origin: j.origin,
      program: j.programId,
      status: j.status,
      code: j.code,
      link: j.link,
      terms: j.terms,
      ledger: j.ledger,
      synced_at: j.syncedAt,
      error: j.error,
      joined_at: j.createdAt,
    })),
  }, { headers: { "cache-control": "no-store" } });
}
