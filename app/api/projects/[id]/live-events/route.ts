// GET /api/projects/[id]/live-events?minutes=30
// Returns recent raw tracker events for the real-time stats panel.
// Requires project owner or member auth.

import { NextRequest, NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { serviceClient } from "@/lib/supabase/service";
import { bucketLabel } from "@/lib/tracker/categorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;

  const access = await requireProjectAccess(projectId);
  if (!access.ok) {
    const status = access.error === "Not authenticated." ? 401 : 404;
    return NextResponse.json({ error: access.error }, { status });
  }

  const minutes = Math.min(
    60,
    Math.max(1, parseInt(request.nextUrl.searchParams.get("minutes") ?? "30", 10)),
  );
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const svc = serviceClient();
  const { data: rows, error } = await svc
    .from("tracker_events")
    .select(
      "id, occurred_at, event, page_path, referrer_host, event_target, bucket, country_code, country_name, city, visitor_id, session_id",
    )
    .eq("project_id", projectId)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const events = rows ?? [];

  // Aggregate by page, source, and country for the summary panels.
  const byPage = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byCountry = new Map<string, { name: string; count: number }>();
  const sessionsSeen = new Set<string>();

  for (const e of events) {
    const page = e.page_path || "/";
    byPage.set(page, (byPage.get(page) ?? 0) + 1);

    const source = bucketLabel(e.bucket) || "Direct";
    bySource.set(source, (bySource.get(source) ?? 0) + 1);

    if (e.country_code) {
      const existing = byCountry.get(e.country_code);
      byCountry.set(e.country_code, {
        name: e.country_name || e.country_code,
        count: (existing?.count ?? 0) + 1,
      });
    }

    if (e.session_id) sessionsSeen.add(e.session_id);
  }

  const topPages = Array.from(byPage.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([page, count]) => ({ page, count }));

  const topSources = Array.from(bySource.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([source, count]) => ({ source, count }));

  const topCountries = Array.from(byCountry.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([code, { name, count }]) => ({ code, name, count }));

  return NextResponse.json({
    minutes,
    total_events: events.length,
    unique_sessions: sessionsSeen.size,
    events: events.slice(0, 100),
    top_pages: topPages,
    top_sources: topSources,
    top_countries: topCountries,
  });
}
