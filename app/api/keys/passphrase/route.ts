// POST /api/keys/passphrase { dek, seal }: change passphrase. Same data key and
// key pair (so every sealed secret stays valid), new salt + wrap.
import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { serviceClient } from "@/lib/supabase/service";
import { base64ToBytes, isSealRecord, verifyDataKey, wipe } from "@/lib/sealed/crypto";
import { forgetCachedSeal, loadSeal } from "@/lib/sealed/vault";

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const ownerId = who.user.id;
  const body = (await req.json().catch(() => ({}))) as { dek?: string; seal?: unknown };
  const current = await loadSeal(ownerId);
  if (!current) return NextResponse.json({ error: "No key passphrase set up." }, { status: 409 });
  if (!isSealRecord(body.seal) || typeof body.dek !== "string") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (body.seal.public_key !== current.public_key) return NextResponse.json({ error: "Key pair must not change." }, { status: 400 });
  const dek = base64ToBytes(body.dek);
  const ok = (await verifyDataKey(dek, current, ownerId)) && (await verifyDataKey(dek, body.seal, ownerId));
  wipe(dek);
  if (!ok) return NextResponse.json({ error: "wrong key" }, { status: 403 });
  const { error } = await serviceClient()
    .from("user_key_seal")
    .update({ seal: body.seal, updated_at: new Date().toISOString() })
    .eq("user_id", ownerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  forgetCachedSeal(ownerId);
  return NextResponse.json({ ok: true });
}
