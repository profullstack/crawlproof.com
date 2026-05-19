import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueGuestPostGenerate } from "@/lib/lx/workerClient";
import { getProjectById } from "@/lib/lx/currentSite";

export const runtime = "nodejs";

// Manually trigger a guest-post generation. Body: { targetSiteId, topic }.
// Author site is resolved from the projectId query param. Worker is
// fire-and-forget; the article shows up on the author's dashboard
// (filter is_guest_post=true) when generation lands.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const projectIdParam = req.nextUrl.searchParams.get("projectId");
  if (!projectIdParam) {
    return NextResponse.json(
      { ok: false, error: "projectId required" },
      { status: 400 },
    );
  }
  const project = await getProjectById(projectIdParam, { siteColumns: "id, status" });
  const authorLx = project?.lx_site as { id?: string; status?: string } | null;
  if (!authorLx?.id) {
    return NextResponse.json(
      { ok: false, error: "autoblog not configured for this project" },
      { status: 400 },
    );
  }
  if (authorLx.status !== "active") {
    return NextResponse.json(
      { ok: false, error: `author site is ${authorLx.status}` },
      { status: 400 },
    );
  }

  let body: { targetSiteId?: string; topic?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  if (!body.targetSiteId || !body.topic) {
    return NextResponse.json(
      { ok: false, error: "targetSiteId and topic are required" },
      { status: 400 },
    );
  }
  if (body.targetSiteId === authorLx.id) {
    return NextResponse.json(
      { ok: false, error: "target must differ from author" },
      { status: 400 },
    );
  }

  // Upfront credit check on the author's account — same UX rationale
  // as own-blog generation. Worker re-checks atomically via
  // consume_credit before doing any LLM work.
  const { data: profile } = await supabase
    .from("profiles")
    .select("credits_balance")
    .eq("id", user.id)
    .maybeSingle();
  const balance = (profile?.credits_balance as number | null | undefined) ?? 0;
  if (balance < 1) {
    return NextResponse.json(
      {
        ok: false,
        error: "Out of credits. Buy more to generate guest posts.",
        credits_balance: balance,
      },
      { status: 402 },
    );
  }

  await enqueueGuestPostGenerate(authorLx.id, body.targetSiteId, body.topic);
  return NextResponse.json({ ok: true });
}
