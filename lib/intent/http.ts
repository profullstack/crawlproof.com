// Shared glue for the /api/intent/v1 routes: auth by session cookie or
// `Authorization: Bearer crp_…`, and IntentError → JSON status.

import { NextResponse, type NextRequest } from "next/server";
import { resolveUser } from "@/lib/affiliate/auth";
import { IntentError } from "./store";

export async function withOwner(
  req: NextRequest,
  fn: (ownerId: string) => Promise<Response | Record<string, unknown>>,
): Promise<Response> {
  const who = await resolveUser(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  try {
    const out = await fn(who.user.id);
    return out instanceof Response ? out : NextResponse.json(out);
  } catch (err) {
    if (err instanceof IntentError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[intent api]", err);
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}
