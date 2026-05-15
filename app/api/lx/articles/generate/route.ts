import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueArticleGenerate } from "@/lib/lx/workerClient";

export const runtime = "nodejs";

// Manually queue an article generation for the caller's site. The worker
// will pick the next queued keyword whose scheduled_for has passed; if
// none is due, the call is a no-op.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { data: site } = await supabase
    .from("lx_site")
    .select("id, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!site) {
    return NextResponse.json(
      { ok: false, error: "no site configured" },
      { status: 404 },
    );
  }
  if (site.status !== "active") {
    return NextResponse.json(
      { ok: false, error: `site is ${site.status}` },
      { status: 400 },
    );
  }

  await enqueueArticleGenerate(site.id);
  return NextResponse.json({ ok: true });
}
