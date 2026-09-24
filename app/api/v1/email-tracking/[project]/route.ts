// GET /api/v1/email-tracking/<project id | hostname>[?secret=1]
//
// One project's email tracking. The secret comes back only with ?secret=1 and
// only to someone who may change the project (never a read-only member): it
// signs every link in every email, so it is handed out on purpose, not by
// default.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { getOrCreateForProject } from "@/lib/emailTracking/store";
import { accessibleProjects, eventCounts, pickProject, shapeTracking } from "@/lib/emailTracking/access";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const siteBase = () => (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { project: ref } = await params;
  const sb = serviceClient();
  try {
    const project = pickProject(await accessibleProjects(sb, auth.userId), decodeURIComponent(ref));
    if (!project) return NextResponse.json({ error: "No such project, or more than one matches. Use the project id." }, { status: 404 });
    const wantsSecret = req.nextUrl.searchParams.get("secret") === "1";
    if (wantsSecret && project.role === "viewer") {
      return NextResponse.json({ error: "Read-only access: the secret is for owners and members." }, { status: 403 });
    }
    const row = await getOrCreateForProject(project.id);
    const counts = await eventCounts(sb, [project.id], new Date(Date.now() - 86_400_000).toISOString());
    return NextResponse.json(shapeTracking(project, row, { siteBase: siteBase(), counts: counts[project.id], withSecret: wantsSecret }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read email tracking." }, { status: 503 });
  }
}
