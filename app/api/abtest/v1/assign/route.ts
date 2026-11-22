// /api/abtest/v1/assign  POST { experiment, unit } -> { arm, new, status }
//
// Sticky: the first call stores the unit's arm (picked deterministically from
// experiment key + unit by @profullstack/abtest), every later call returns it.
import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { assignByKey } from "@/lib/abtest/store";
import { authed, errorResponse, jsonBody } from "@/lib/abtest/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  try {
    return NextResponse.json(await assignByKey(serviceClient(), a.userId, await jsonBody(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
