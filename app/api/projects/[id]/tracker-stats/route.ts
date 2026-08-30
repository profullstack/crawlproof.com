// GET /api/projects/[id]/tracker-stats?range=1h&panel=pages
//
// Re-renders one stats panel at a different timeframe. The stats page
// server-renders every panel at the default range; each card's timeframe tabs
// call this for the range the reader picks, so switching a tab costs one small
// aggregate instead of a full page reload.
//
// `panel` may be repeated (or comma-separated) to fetch several at once.
// Requires project owner or member auth, same as the other project routes.

import { NextRequest, NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { serviceClient } from "@/lib/supabase/service";
import { trackerRange, rangesForPanel } from "@/lib/tracker/ranges";
import { fetchPanels, PANEL_KEYS, type PanelKey } from "@/lib/tracker/panels";

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

  const sp = request.nextUrl.searchParams;
  const range = trackerRange(sp.get("range"));

  const requested = sp
    .getAll("panel")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  const panels = (requested.length ? requested : PANEL_KEYS).filter(
    (p): p is PanelKey => (PANEL_KEYS as string[]).includes(p),
  );

  if (!panels.length) {
    return NextResponse.json({ error: "Unknown panel." }, { status: 400 });
  }

  // A panel that has no data at this resolution should say so rather than
  // quietly answering a different question — devices/browsers/OS and exit
  // pages have no sub-day source, so a 1H request for them is a client bug.
  const unsupported = panels.filter(
    (p) => !rangesForPanel(p).some((r) => r.key === range.key),
  );
  if (unsupported.length) {
    return NextResponse.json(
      {
        error: `Panel(s) ${unsupported.join(", ")} do not support the ${range.key} range.`,
      },
      { status: 400 },
    );
  }

  try {
    const data = await fetchPanels(serviceClient(), projectId, panels, range);
    return NextResponse.json({ range: range.key, panels: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Stats query failed." },
      { status: 500 },
    );
  }
}
