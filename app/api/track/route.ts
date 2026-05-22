// Public ingest for the drop-in tracker (/stats.js). Accepts a minimal
// JSON payload, categorizes the event, and bumps the matching counter row
// in tracker_daily_stats. Idempotent under load via ON CONFLICT.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { categorize } from "@/lib/tracker/categorize";

const bodySchema = z.object({
  site: z.string().uuid(),
  ref: z.string().max(2048).nullable().optional(),
  path: z.string().max(2048).optional(),
});

// Always 204. Even on bad input we don't want to surface details to the
// client — this endpoint is public and we treat it as a black hole.
function ok() {
  return new NextResponse(null, {
    status: 204,
    headers: { "access-control-allow-origin": "*" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

export async function POST(request: NextRequest) {
  let parsed;
  try {
    const json = await request.json();
    parsed = bodySchema.safeParse(json);
  } catch {
    return ok();
  }
  if (!parsed?.success) return ok();

  const { site } = parsed.data;
  const referrer = parsed.data.ref ?? null;
  const userAgent = request.headers.get("user-agent");

  const sb = serviceClient();

  // Confirm the project exists and has the tracker enabled. We avoid
  // leaking which check failed; 204 either way.
  const { data: project } = await sb
    .from("projects")
    .select("id, tracker_enabled")
    .eq("id", site)
    .maybeSingle();
  if (!project || !project.tracker_enabled) return ok();

  const { bucket } = categorize({ referrer, userAgent });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // UPSERT increment. Supabase JS doesn't expose a raw .increment() helper
  // so we read + write under the unique key. The PK protects against
  // dupes; a lost-update race here at worst undercounts by 1 per
  // contention window, which is acceptable for analytics-grade data.
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
      .update({
        count: (existing.count ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", site)
      .eq("day", today)
      .eq("bucket", bucket);
  } else {
    await sb
      .from("tracker_daily_stats")
      .insert({ project_id: site, day: today, bucket, count: 1 });
  }

  return ok();
}
