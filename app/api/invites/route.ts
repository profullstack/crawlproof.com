// GET  /api/invites          — your quota, your invites, bonus status.
// POST /api/invites { note } — create one (scarce: 3 per account).
// Session cookie or `Authorization: Bearer crp_…`.

import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { env } from "@/lib/env";
import {
  InviteError,
  createInvite,
  inviteOverview,
  inviteUrl,
  originFromHeaders,
  settleInviteBonus,
  settleInvitesSentBy,
} from "@/lib/creditCodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  await settleInvitesSentBy(who.user.id);
  await settleInviteBonus(who.user.id).catch(() => null);
  return NextResponse.json(await inviteOverview(who.user.id));
}

export async function POST(req: NextRequest) {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  try {
    const inv = await createInvite(who.user.id, typeof body.note === "string" ? body.note : "");
    return NextResponse.json(
      {
        ok: true,
        id: inv.id,
        code: inv.code,
        url: inviteUrl(originFromHeaders(req.headers, env.siteUrl), inv.code),
        expiresAt: inv.expiresAt,
        note: inv.note,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof InviteError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: err.status });
    }
    throw err;
  }
}
