import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueArticleGenerate } from "@/lib/lx/workerClient";
import { getCurrentSite } from "@/lib/lx/currentSite";

export const runtime = "nodejs";

// Manually queue an article generation for the current site. The worker
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

  const site = (await getCurrentSite("id, status")) as
    | { id: string; status: string; lx_site_id: string | null }
    | null;
  if (!site) {
    return NextResponse.json(
      { ok: false, error: "no site configured" },
      { status: 404 },
    );
  }
  if (!site.lx_site_id) {
    return NextResponse.json(
      { ok: false, error: "autoblog not configured for this project" },
      { status: 400 },
    );
  }
  if (site.status !== "active") {
    return NextResponse.json(
      { ok: false, error: `site is ${site.status}` },
      { status: 400 },
    );
  }

  // Cheap upfront check so the UI surfaces "out of credits" instead of
  // silently no-op'ing in the worker. The worker still re-checks
  // atomically via consume_credit before generation begins.
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
        error: "Out of credits. Buy more to generate articles.",
        credits_balance: balance,
      },
      { status: 402 },
    );
  }

  // The button is a manual "generate now" — bypass the cron's
  // scheduled_for filter so it actually produces something when the
  // earliest queued slot is in the future. Default behavior (preview=true)
  // leaves the article in 'ready' state for review before publish.
  await enqueueArticleGenerate(site.lx_site_id, { manual: true, preview: true });
  return NextResponse.json({ ok: true });
}
