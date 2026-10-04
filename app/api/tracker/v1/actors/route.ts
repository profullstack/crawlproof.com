// /api/tracker/v1/actors — declared actors (lib/tracker/actors.ts).
//
//   GET                       list this account's actors, tokens, 30-day use
//   POST {email, kind, name?, operator?, visibility?, token_label?}
//                             register one; token_label also mints a token,
//                             returned ONCE in `token`
//
// Auth: Bearer crp_… or a dashboard session.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { actorOwner } from "@/lib/tracker/actorAuth";
import { createActor, listActors } from "@/lib/tracker/actorStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const owner = await actorOwner(req);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
  const res = await listActors(serviceClient(), owner.userId);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ actors: res.value });
}

export async function POST(req: NextRequest) {
  const owner = await actorOwner(req);
  if (!owner.ok) return NextResponse.json({ error: owner.error }, { status: owner.status });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const res = await createActor(serviceClient(), owner.userId, {
    email: body.email,
    kind: body.kind,
    name: body.name,
    operator: body.operator,
    visibility: body.visibility,
    tokenLabel: body.token_label,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json(res.value, { status: 201 });
}
