// POST /api/keys/lock: drop the caller's private key from memory everywhere.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { forwardToWorker, lockLocal } from "@/lib/sealed/session";

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  lockLocal(who.user.id);
  const worker = await forwardToWorker("/sealed/lock", { owner_id: who.user.id });
  return NextResponse.json({ ok: true, worker_locked: worker });
}
