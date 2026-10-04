// /api/tracker/v1/actors/:id
//
//   PATCH {name?, visibility?, operator?}   edit
//   DELETE                                  revoke the actor and all its tokens

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { actorOwner } from "@/lib/tracker/actorAuth";
import { revokeActor, updateActor } from "@/lib/tracker/actorStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const owner = await actorOwner(req);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const res = await updateActor(serviceClient(), owner.userId, id, body);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const owner = await actorOwner(req);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
  const { id } = await ctx.params;
  const res = await revokeActor(serviceClient(), owner.userId, id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true });
}
