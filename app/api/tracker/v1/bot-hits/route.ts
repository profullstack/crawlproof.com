// /api/tracker/v1/bot-hits — server-side bot counts from a site's own gateway.
//
//   POST { site, hits: [{ bucket: "bot:swarm", path: "/i/123", count: 40 }] }
//
// Full-access tokens only (a read-only stats token cannot write), and only
// into the token owner's own projects. Only `bot:` buckets are accepted, so
// this can move numbers onto the bot side and never invent people.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { resolveProject } from "@/lib/tracker/apiStats";
import { parseBotHits } from "@/lib/tracker/botHits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON." }, { status: 400 });
  }
  const parsed = parseBotHits(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const sb = serviceClient();
  const resolved = await resolveProject(sb, auth.userId, parsed.site);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  const site = resolved.project.id;
  const today = new Date().toISOString().slice(0, 10);

  const buckets = new Map<string, number>();
  for (const h of parsed.hits) buckets.set(h.bucket, (buckets.get(h.bucket) ?? 0) + h.count);

  for (const [bucket, count] of buckets) {
    const { data: existing } = await sb
      .from("tracker_daily_stats")
      .select("count")
      .eq("project_id", site)
      .eq("day", today)
      .eq("bucket", bucket)
      .maybeSingle();
    if (existing) {
      await sb
        .from("tracker_daily_stats")
        .update({ count: (existing.count ?? 0) + count, updated_at: new Date().toISOString() })
        .eq("project_id", site)
        .eq("day", today)
        .eq("bucket", bucket);
    } else {
      await sb.from("tracker_daily_stats").insert({ project_id: site, day: today, bucket, count });
    }
  }

  for (const h of parsed.hits) {
    const match = { project_id: site, day: today, event: "pageview", page_path: h.path, referrer_host: "", event_target: "", kind: "bot" };
    const { data: existing } = await sb.from("tracker_event_daily_stats").select("count").match(match).maybeSingle();
    if (existing) {
      await sb
        .from("tracker_event_daily_stats")
        .update({ count: (existing.count ?? 0) + h.count, updated_at: new Date().toISOString() })
        .match(match);
    } else {
      await sb.from("tracker_event_daily_stats").insert({ ...match, count: h.count });
    }
  }

  const total = [...buckets.values()].reduce((a, b) => a + b, 0);
  return NextResponse.json({ ok: true, site, recorded: total, buckets: Object.fromEntries(buckets) });
}
