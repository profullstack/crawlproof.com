import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { loadCrawlerStats } from "@/lib/lx/feedCrawlStats";

export const runtime = "nodejs";
// A cached status response reports the cache's health rather than the
// crawler's, and would keep answering "fine" straight through an outage.
export const dynamic = "force-dynamic";

/**
 * Counts only.
 *
 * The per-feed rows stay on the dashboard page behind a session: this is the
 * shape a monitor polls, and it has no reason to carry the error strings some
 * upstream server wrote.
 */
export async function GET() {
  const { stats } = await loadCrawlerStats(serviceClient());
  return NextResponse.json(stats, { headers: { "cache-control": "no-store" } });
}
