import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueSitemapCrawl } from "@/lib/lx/workerClient";

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
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!site) {
    return NextResponse.json(
      { ok: false, error: "no site configured" },
      { status: 404 },
    );
  }

  // Mark queued so the dashboard reflects state immediately; worker flips
  // to 'crawling' when it picks up.
  await supabase
    .from("lx_site")
    .update({ sitemap_status: "queued" })
    .eq("id", site.id);

  await enqueueSitemapCrawl(site.id);
  return NextResponse.json({ ok: true });
}
