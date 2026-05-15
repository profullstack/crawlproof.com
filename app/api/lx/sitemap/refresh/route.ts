import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enqueueSitemapCrawl } from "@/lib/lx/workerClient";
import { getCurrentSite } from "@/lib/lx/currentSite";

export const runtime = "nodejs";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const site = (await getCurrentSite("id")) as { id: string } | null;
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
