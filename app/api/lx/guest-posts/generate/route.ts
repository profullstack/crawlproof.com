import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueGuestPostGenerate } from "@/lib/lx/workerClient";
import { getProjectById } from "@/lib/lx/currentSite";
import { serviceClient } from "@/lib/supabase/service";
import { SCAN_CREDITS } from "@/lib/credits";

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
  const authorSiteId = authorLx.id;

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
  if (balance < SCAN_CREDITS) {
    return NextResponse.json(
      {
        ok: false,
        error: "Out of credits. Buy more to generate guest posts.",
        credits_balance: balance,
      },
      { status: 402 },
    );
  }

  const enqueueExisting = async (requestId: string) => {
    await enqueueGuestPostGenerate(authorSiteId, body.targetSiteId!, body.topic!, {
      requestId,
    });
  };

  // Record the request before enqueueing so the UI can show an
  // indicator immediately and the user can cancel before generation
  // completes. Unique on (author, target, topic) — if a row already
  // exists in a non-terminal state we hand back its id instead of
  // double-queuing. A previously 'failed' row blocks re-queue; user
  // must delete it first (or we surface a retry path later).
  const { data: existing } = await supabase
    .from("lx_guest_post_request")
    .select("id, status, article_id")
    .eq("author_site_id", authorLx.id)
    .eq("target_site_id", body.targetSiteId)
    .eq("topic", body.topic)
    .maybeSingle();

  if (existing) {
    if (existing.status === "generated") {
      return NextResponse.json(
        {
          ok: false,
          error: "Guest post already generated for this topic.",
          request: existing,
        },
        { status: 409 },
      );
    }
    if (existing.status === "failed") {
      const svc = serviceClient();
      const { data: reset, error: resetErr } = await svc
        .from("lx_guest_post_request")
        .update({ status: "queued", error_text: null })
        .eq("id", existing.id)
        .select("id, status, article_id")
        .maybeSingle();
      if (resetErr || !reset) {
        return NextResponse.json(
          { ok: false, error: resetErr?.message ?? "could not retry request" },
          { status: 500 },
        );
      }
      await enqueueExisting(existing.id);
      return NextResponse.json({ ok: true, request: reset, retried: true });
    }
    if (existing.status === "queued") {
      await enqueueExisting(existing.id);
    }
    // queued / generating → return the existing row. queued is re-notified
    // above so a lost worker notification does not strand the request.
    return NextResponse.json({ ok: true, request: existing });
  }

  const { data: inserted, error: insErr } = await supabase
    .from("lx_guest_post_request")
    .insert({
      author_site_id: authorLx.id,
      target_site_id: body.targetSiteId,
      topic: body.topic,
      status: "queued",
    })
    .select("id, status")
    .single();
  if (insErr || !inserted) {
    return NextResponse.json(
      { ok: false, error: insErr?.message ?? "could not record request" },
      { status: 500 },
    );
  }

  await enqueueExisting(inserted.id);
  return NextResponse.json({ ok: true, request: inserted });
}
