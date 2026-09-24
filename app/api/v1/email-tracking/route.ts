// GET /api/v1/email-tracking — every project the token's user can reach, with
// its email tracking id, whether it is on, and the last day's human opens,
// clicks and unsubscribes. No secrets here; ask for one project with
// ?secret=1 for that.
//
// Same crp_ bearer as /api/ads/v1/*. This is what `crawlproof email-tracking
// list`, the TUI's Email tab and `myna newsletter track connect` read.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { getOrCreateForProject } from "@/lib/emailTracking/store";
import { accessibleProjects, eventCounts, shapeTracking } from "@/lib/emailTracking/access";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const siteBase = () => (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const sb = serviceClient();
  try {
    const projects = await accessibleProjects(sb, auth.userId);
    const counts = await eventCounts(sb, projects.map((p) => p.id), new Date(Date.now() - 86_400_000).toISOString());
    const rows = [];
    for (const project of projects) {
      const row = await getOrCreateForProject(project.id);
      rows.push(shapeTracking(project, row, { siteBase: siteBase(), counts: counts[project.id] }));
    }
    return NextResponse.json({ projects: rows }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read email tracking." }, { status: 503 });
  }
}
