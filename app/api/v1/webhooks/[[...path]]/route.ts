// /api/v1/webhooks: the @profullstack/webhooks API for autoblog sites.
//
// Auth: a full-access crp_ API token (`Authorization: Bearer crp_…`, Social →
// API tokens; read-only stats tokens are refused) or a dashboard session.
// Endpoints belong to one autoblog site: pick it with `?site=<domain|id>`
// (optional when the account has one site).
//
//   GET    /                      endpoints + event_types
//   POST   /                      { url, events?, description? } -> { endpoint, secret }
//   GET|PATCH|DELETE /:id
//   GET    /:id/secret            POST /:id/rotate      POST /:id/test
//   GET    /:id/deliveries        GET /deliveries       POST /deliveries/:id/retry
//
// Deliveries are CloudEvents signed per Standard Webhooks, plus
// `Authorization: Bearer <secret>` for receivers on @profullstack/autoblog.

import { NextResponse, type NextRequest } from "next/server";
import { webhooksApi } from "@profullstack/webhooks";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { serviceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { getHooks } from "@/lib/webhooks/hub";
import { resolveOwnedSite } from "@/lib/webhooks/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function callerId(req: NextRequest): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  if (req.headers.get("authorization")) {
    const auth = await authenticateBearer(req);
    return auth.ok ? { ok: true, userId: auth.userId } : auth;
  }
  try {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) return { ok: true, userId: user.id };
  } catch {
    // no session
  }
  return { ok: false, status: 401, error: "Sign in or send a crp_ API token (Authorization: Bearer crp_…)." };
}

async function handle(req: NextRequest): Promise<Response> {
  const who = await callerId(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const site = await resolveOwnedSite(serviceClient(), who.userId, new URL(req.url).searchParams.get("site"));
  if (!site.ok) return NextResponse.json({ error: site.error }, { status: site.status });

  const api = webhooksApi(getHooks(), { basePath: "/api/v1/webhooks", owner: () => site.site.id });
  try {
    return (await api(req)) ?? NextResponse.json({ error: "Not found" }, { status: 404 });
  } catch (err) {
    console.error("[webhooks api]", err);
    return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
