// POST /api/v1/email-tracking/<project id | hostname>/<enable | disable | rotate>
//
// The dashboard tab's two buttons, for a bearer token. Both change what every
// future email does, so a read-only member is refused. Rotate answers with the
// new secret (the old one keeps verifying until the next rotation, so mail
// already sent still works); enable and disable answer without it.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { rotateSecret, setEnabled } from "@/lib/emailTracking/store";
import { accessibleProjects, isAction, pickProject, shapeTracking } from "@/lib/emailTracking/access";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const siteBase = () => (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");

export async function POST(req: NextRequest, { params }: { params: Promise<{ project: string; action: string }> }) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { project: ref, action } = await params;
  if (!isAction(action)) return NextResponse.json({ error: "The action is enable, disable or rotate." }, { status: 404 });
  const sb = serviceClient();
  try {
    const project = pickProject(await accessibleProjects(sb, auth.userId), decodeURIComponent(ref));
    if (!project) return NextResponse.json({ error: "No such project, or more than one matches. Use the project id." }, { status: 404 });
    if (project.role === "viewer") {
      return NextResponse.json({ error: "Read-only access: you can't change this project's tracking." }, { status: 403 });
    }
    const row = action === "rotate" ? await rotateSecret(project.id) : await setEnabled(project.id, action === "enable");
    return NextResponse.json(shapeTracking(project, row, { siteBase: siteBase(), withSecret: action === "rotate" }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change email tracking." }, { status: 503 });
  }
}
