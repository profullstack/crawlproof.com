import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueKeywordResearch } from "@/lib/lx/workerClient";

export const runtime = "nodejs";

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
    .select("id, niche, target_audiences")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!site) {
    return NextResponse.json(
      { ok: false, error: "no site configured" },
      { status: 404 },
    );
  }
  if (!site.niche && (site.target_audiences ?? []).length === 0) {
    return NextResponse.json(
      { ok: false, error: "set a niche or target audience before generating keywords" },
      { status: 400 },
    );
  }

  await enqueueKeywordResearch(site.id);
  return NextResponse.json({ ok: true });
}
