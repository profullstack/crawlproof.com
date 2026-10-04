// /api/tracker/v1/actors/:id/tokens
//
//   POST {label?}          mint a cpa_ token; returned ONCE in `token`
//                          (label "browser" = name it after the caller's UA)
//   DELETE ?token=<id>     revoke one token, leaving the actor's others live

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { actorOwner } from "@/lib/tracker/actorAuth";
import { mintToken, revokeToken } from "@/lib/tracker/actorStore";
import { browserLabel } from "@/lib/tracker/actors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const owner = await actorOwner(req);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // "browser" asks for a label naming the calling browser, so the token list
  // says which machine a dashboard-declared token lives on.
  const label = body.label === "browser" ? browserLabel(req.headers.get("user-agent")) : body.label;
  const res = await mintToken(serviceClient(), owner.userId, id, label);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.value, { status: 201 });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const owner = await actorOwner(req);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
  const { id } = await ctx.params;
  const tokenId = req.nextUrl.searchParams.get("token") ?? "";
  const res = await revokeToken(serviceClient(), owner.userId, id, tokenId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true });
}
