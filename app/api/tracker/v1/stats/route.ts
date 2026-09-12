// /api/tracker/v1/stats — a project's traffic for a bearer-token caller.
//
//   GET ?site=<hostname|uuid|name>&range=1h&who=humans
//
// The dashboard reads the same panels through a session; this is the same data
// for something holding an API token, which is what `crawlproof stats` calls.
// Auth matches /api/ads/v1/*: `Authorization: Bearer crp_…`, and the project is
// always scoped to the token's owner.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { projectStats, resolveProject } from "@/lib/tracker/apiStats";
import { trackerRange } from "@/lib/tracker/ranges";
import { DEFAULT_WHO, parseWho, WHO_PARAM, whoToKind } from "@/lib/tracker/who";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Anything but an affirmative is off, so a typo cannot buy an extra query. */
export function parseDetail(raw: string | null): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const sp = req.nextUrl.searchParams;

  // An unknown `who` is a 400 rather than a quiet fall-back, so a typo cannot
  // answer a different question than the one asked.
  const whoParam = sp.get(WHO_PARAM);
  const who = whoParam === null ? DEFAULT_WHO : parseWho(whoParam);
  if (!who) {
    return NextResponse.json({ error: "Unknown who. Expected humans, bots or all." }, { status: 400 });
  }

  const sb = serviceClient();
  const resolved = await resolveProject(sb, auth.userId, sp.get("site"));
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });

  // `detail=1` adds the series and the unfiltered human / bot mix, which is
  // what the dashboard's per-domain screen and its risk-to-viral score are
  // built from. Off by default: `crawlproof stats` prints neither, and a
  // fleet-wide fan-out should not pay for a panel nobody renders.
  const detail = parseDetail(sp.get("detail"));

  const range = trackerRange(sp.get("range"));
  const stats = await projectStats(sb, resolved.project, range, whoToKind(who), who, detail);
  return NextResponse.json(stats);
}
