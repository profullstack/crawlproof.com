import type { NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { handleUptimeApi, supabaseUptimeStore } from "@/lib/uptime-partner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Partner uptime API: /api/uptime/v1/{settings,keys,monitors[/:id[/incidents]]}.
// Bearer cpu_ partner token + X-Fleet-User-Email; see lib/uptime-partner.ts.
type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return handleUptimeApi(req, path ?? [], { store: supabaseUptimeStore(serviceClient()) });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
