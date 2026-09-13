// POST /api/affiliate/v1/events/:join — a merchant we joined posting an
// event about our membership there. The join id in the path is the only
// credential a merchant without jwks can offer; it is unguessable, and a
// forged event can do nothing but trigger a re-read of the real ledger.
import { NextResponse, type NextRequest } from "next/server";
import { recordInboundEvent } from "@/lib/affiliate/directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ join: string }> }) {
  const { join } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(join)) return NextResponse.json({ error: "not found" }, { status: 404 });
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const ok = await recordInboundEvent(join, payload);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
