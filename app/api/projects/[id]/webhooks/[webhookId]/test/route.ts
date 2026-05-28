// POST /api/projects/[id]/webhooks/[webhookId]/test — send a synthetic
// tracker.test event to the webhook and report status/timing back.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  buildTrackerEvent,
  deliverAndRecord,
} from "@/lib/tracker/webhookDeliver";

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; webhookId: string }> },
) {
  const { id: projectId, webhookId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: hook } = await supabase
    .from("tracker_webhooks")
    .select("id, url, secret, project_id")
    .eq("id", webhookId)
    .eq("project_id", projectId)
    .maybeSingle<{ id: string; url: string; secret: string; project_id: string }>();
  if (!hook) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const event = buildTrackerEvent({
    type: "tracker.test",
    project_id: hook.project_id,
    data: {
      event: "test",
      bucket: "test",
      page_path: "/",
      page_url: null,
      referrer: null,
      referrer_host: "",
      target: "",
      user_agent: "crawlproof-test",
      geo: null,
    },
  });

  const outcome = await deliverAndRecord(supabase, hook, event);
  return NextResponse.json(outcome);
}
