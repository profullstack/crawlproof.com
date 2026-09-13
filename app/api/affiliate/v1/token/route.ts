// POST /api/affiliate/v1/token — rotate the caller's affiliate token. The
// new one is shown once; the old one stops working at once.
import { NextResponse, type NextRequest } from "next/server";
import { resolveCaller } from "@/lib/affiliate/auth";
import { rotateToken } from "@/lib/affiliate/memberships";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const token = await rotateToken(caller.membership.id);
  return NextResponse.json({ membership: caller.membership.id, token });
}
