// POST /api/invites/accept { code } — join on an invite (new accounts only).
// The bonus is paid to both sides once this account's email is confirmed and
// it passes the abuse checks; the response says whether that happened yet.

import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { INVITE_COOKIE, acceptInvite } from "@/lib/creditCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) return NextResponse.json({ error: "Enter an invite code.", reason: "invalid" }, { status: 400 });

  const r = await acceptInvite(who.user.id, code);
  const res = r.ok
    ? NextResponse.json(r)
    : NextResponse.json({ error: r.message, reason: r.reason }, { status: r.reason === "no_account" ? 404 : 400 });
  res.cookies.set(INVITE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
