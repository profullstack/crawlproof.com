// /api/tracker/v1/bot-hits — server-side bot counts from a site's own gateway.
//
//   POST { site, hits: [{ bucket: "bot:swarm", path: "/i/123", count: 40 }] }
//
// With a full-access bearer token, `site` is any of the owner's projects (id,
// hostname or name). Without one it is like the beacon, which is anonymous
// too: `site` must be a tracker-enabled project's id or hostname, and a call
// carries at most ANON_MAX_TOTAL hits. Either way only `bot:` buckets are
// accepted, so the worst a forged call can do is what a forged beacon with a
// GPTBot user agent already does: add to a bot count. It cannot invent people.

import { NextResponse, type NextRequest } from "next/server";

import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { resolveProject } from "@/lib/tracker/apiStats";
import { ANON_MAX_TOTAL, parseBotHits, resolveTrackedSite } from "@/lib/tracker/botHits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON." }, { status: 400 });
  }
  const parsed = parseBotHits(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const sb = serviceClient();
  let site: string;
  if (req.headers.get("authorization")) {
    const auth = await authenticateBearer(req);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const resolved = await resolveProject(sb, auth.userId, parsed.site);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    site = resolved.project.id;
  } else {
    const sum = parsed.hits.reduce((a, h) => a + h.count, 0);
    if (sum > ANON_MAX_TOTAL) {
      return NextResponse.json({ error: `At most ${ANON_MAX_TOTAL} hits per call without a token.` }, { status: 413 });
    }
    const found = parsed.site ? await resolveTrackedSite(sb, parsed.site) : null;
    if (!found) return NextResponse.json({ error: "Unknown or untracked site." }, { status: 404 });
    site = found;
  }
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
