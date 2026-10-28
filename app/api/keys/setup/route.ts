// POST /api/keys/setup { seal, dek, ttl_seconds?, reset? }
// The browser/CLI created the seal locally from the user's passphrase. We store
// the seal (ciphertext + salt + KDF params + key check + public key), unlock
// with the data key, and migrate this user's legacy secrets in this request.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { serviceClient } from "@/lib/supabase/service";
import { base64ToBytes, isSealRecord, verifyDataKey, wipe } from "@/lib/sealed/crypto";
import { clearNudge, forwardToWorker, unlockWithDataKey, UnlockError } from "@/lib/sealed/session";
import { forgetCachedSeal } from "@/lib/sealed/vault";
import { migrateOwnerSecrets } from "@/lib/sealed/migrate";

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const ownerId = who.user.id;
  let body: { seal?: unknown; dek?: string; ttl_seconds?: number; reset?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!isSealRecord(body.seal)) return NextResponse.json({ error: "Invalid seal." }, { status: 400 });
  if (typeof body.dek !== "string") return NextResponse.json({ error: "dek required" }, { status: 400 });
  const dek = base64ToBytes(body.dek);
  const ok = await verifyDataKey(dek, body.seal, ownerId);
  wipe(dek);
  if (!ok) return NextResponse.json({ error: "Seal does not match the data key." }, { status: 400 });

  const sb = serviceClient();
  const { data: existing } = await sb.from("user_key_seal").select("seal").eq("user_id", ownerId).maybeSingle();
  if ((existing as { seal?: unknown } | null)?.seal && !body.reset) {
    return NextResponse.json({ error: "A key passphrase is already set. Unlock it, or reset (secrets sealed under the old one are lost)." }, { status: 409 });
  }
  const { error } = await sb
    .from("user_key_seal")
    .upsert({ user_id: ownerId, seal: body.seal, seal_version: 2, locked_nudged_at: null, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  forgetCachedSeal(ownerId);

  try {
    const { expiresAt } = await unlockWithDataKey(ownerId, body.dek, body.ttl_seconds);
    const worker = await forwardToWorker("/sealed/unlock", { owner_id: ownerId, dek: body.dek, ttl_seconds: body.ttl_seconds });
    const migration = await migrateOwnerSecrets(ownerId, (body.seal as { public_key: string }).public_key);
    await clearNudge(ownerId);
    return NextResponse.json({ ok: true, expires_at: expiresAt, worker_unlocked: worker, migration });
  } catch (err) {
    const e = err instanceof UnlockError ? err : new UnlockError("could not unlock");
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
}
