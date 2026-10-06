import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
// A cached answer reports the cache's health, not the app's.
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

/**
 * Public liveness + database check for status.profullstack.com. One head-only
 * PostgREST count with a 3s cap; the reason for a failure is never returned.
 */
export async function GET() {
  try {
    const { error } = await serviceClient()
      .from("projects")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(3000));
    if (error) throw error;
  } catch {
    return NextResponse.json({ status: "error", db: "down" }, { status: 503, headers });
  }
  return NextResponse.json({ status: "ok", db: "ok" }, { headers });
}
