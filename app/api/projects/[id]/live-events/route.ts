// GET /api/projects/[id]/live-events?minutes=30
// Returns recent raw tracker events for the real-time stats panel.
// Requires project owner or member auth.

import { NextRequest, NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { serviceClient } from "@/lib/supabase/service";
import { bucketLabel } from "@/lib/tracker/categorize";

// Approximate country centroids — fallback when precise lat/lng is missing.
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  US:[37.1,-95.7],GB:[55.4,-3.4],DE:[51.2,10.4],FR:[46.2,2.2],CA:[56.1,-106.3],
  AU:[-25.3,133.8],JP:[36.2,138.3],CN:[35.9,104.2],IN:[20.6,78.9],BR:[-14.2,-51.9],
  MX:[23.6,-102.5],RU:[61.5,105.3],KR:[35.9,127.8],IT:[41.9,12.6],ES:[40.5,-3.7],
  NL:[52.1,5.3],SE:[60.1,18.6],NO:[60.5,8.5],PL:[51.9,19.1],UA:[48.4,31.2],
  ZA:[-30.6,22.9],NG:[9.1,8.7],EG:[26.8,30.8],KE:[-0.0,37.9],GH:[7.9,-1.0],
  AR:[-38.4,-63.6],CL:[-35.7,-71.5],CO:[4.6,-74.3],PE:[-9.2,-75.0],VE:[6.4,-66.6],
  SG:[1.3,103.8],MY:[4.2,108.0],TH:[15.9,100.9],VN:[14.1,108.3],ID:[-0.8,113.9],
  PH:[12.9,121.8],PK:[30.4,69.3],BD:[23.7,90.4],LK:[7.9,80.8],NZ:[-40.9,174.9],
  SA:[23.9,45.1],AE:[23.4,53.8],IL:[31.0,34.9],TR:[38.9,35.2],IR:[32.4,53.7],
  CH:[46.8,8.2],AT:[47.5,14.6],BE:[50.5,4.5],PT:[39.4,-8.2],DK:[56.3,9.5],
  FI:[61.9,25.7],CZ:[49.8,15.5],HU:[47.2,19.5],RO:[45.9,24.9],GR:[39.1,21.8],
};

function countryLatLng(code: string): [number, number] | null {
  return COUNTRY_CENTROIDS[code?.toUpperCase()] ?? null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;

  const access = await requireProjectAccess(projectId, { allowViewer: true });
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
      "id, occurred_at, event, page_path, referrer_host, event_target, bucket, country_code, country_name, city, lat, lng, visitor_id, session_id",
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

  // Build globe points: dedupe by visitor_id (one pin per visitor), keep freshest.
  const globePoints: { lat: number; lng: number; label: string; age_s: number; visitor_id: string }[] = [];
  const seenVisitors = new Map<string, number>(); // visitor_id → index in globePoints
  for (const e of events) {
    // Use precise coords when available, fall back to country centroid.
    let lat = e.lat;
    let lng = e.lng;
    if (lat == null || lng == null) {
      const centroid = countryLatLng(e.country_code);
      if (!centroid) continue;
      [lat, lng] = centroid;
    }
    const vid = e.visitor_id || `${lat.toFixed(1)},${lng.toFixed(1)}`;
    const age_s = Math.floor((Date.now() - new Date(e.occurred_at).getTime()) / 1000);
    const label = [e.city, e.country_name].filter(Boolean).join(", ") || e.country_code || "";
    if (seenVisitors.has(vid)) {
      const idx = seenVisitors.get(vid)!;
      if (age_s < globePoints[idx].age_s) {
        globePoints[idx] = { lat, lng, label, age_s, visitor_id: vid };
      }
    } else {
      seenVisitors.set(vid, globePoints.length);
      globePoints.push({ lat, lng, label, age_s, visitor_id: vid });
    }
  }

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
    // Up to 300 so the live chart can bucket a fuller slice of the window;
    // the feed only renders the first 40 and the globe uses globe_points.
    events: events.slice(0, 300),
    globe_points: globePoints,
    top_pages: topPages,
    top_sources: topSources,
    top_countries: topCountries,
  });
}
