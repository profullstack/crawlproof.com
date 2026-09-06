// /api/tracker/v1/sites — the projects this token can read stats for.
//
//   GET → { sites: [{ id, name, url, tracker_enabled }] }
//
// /stats already names them, but only inside the 400 it returns when the
// account has more than one and the caller did not say which. A client that
// wants the whole fleet should not have to parse an error message to find it.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { listProjects } from "@/lib/tracker/apiStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const listed = await listProjects(serviceClient(), auth.userId);
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: listed.status });

  return NextResponse.json({
    sites: listed.projects.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      tracker_enabled: p.tracker_enabled ?? null,
    })),
  });
}
