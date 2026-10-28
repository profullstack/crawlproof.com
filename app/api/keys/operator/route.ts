// POST /api/keys/operator  (admin only)
// Seals the CURRENT env values of the operator keys (COINPAY_API_KEY,
// X402_PRIVATE_KEY) to the calling admin's own key. After this the env value
// is never read for those names and can be removed from app.env. The admin's
// unlock (default 7d) is what lets payouts / paid crawls run.
import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { hasSeal } from "@/lib/sealed/vault";
import { importOperatorSecretsFromEnv, operatorStatus } from "@/lib/sealed/operator";

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  if (!(await hasSeal(admin.userId))) {
    return NextResponse.json({ error: "Set up your key passphrase first." }, { status: 409 });
  }
  const result = await importOperatorSecretsFromEnv(admin.userId);
  return NextResponse.json({ ok: true, ...result, status: await operatorStatus() });
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) return admin.res;
  return NextResponse.json({ status: await operatorStatus() });
}
