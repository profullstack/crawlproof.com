// POST /api/keys/unlock { dek, ttl_seconds? }  (default 8h, max 7d)
// The client derived the data key from the passphrase; the passphrase never
// leaves it. We keep the opened private key in process memory only.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { clearNudge, forwardToWorker, unlockWithDataKey, UnlockError } from "@/lib/sealed/session";
import { loadSeal } from "@/lib/sealed/vault";
import { migrateOwnerSecrets } from "@/lib/sealed/migrate";

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const ownerId = who.user.id;
  let body: { dek?: string; ttl_seconds?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  try {
    const { expiresAt } = await unlockWithDataKey(ownerId, body.dek ?? "", body.ttl_seconds);
    const worker = await forwardToWorker("/sealed/unlock", { owner_id: ownerId, dek: body.dek, ttl_seconds: body.ttl_seconds });
    // Any legacy rows left (e.g. an org created before setup) migrate now.
    const seal = await loadSeal(ownerId);
    const migration = seal ? await migrateOwnerSecrets(ownerId, seal.public_key) : null;
    await clearNudge(ownerId);
    return NextResponse.json({ ok: true, expires_at: expiresAt, worker_unlocked: worker, migration });
  } catch (err) {
    const e = err instanceof UnlockError ? err : new UnlockError("could not unlock");
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
