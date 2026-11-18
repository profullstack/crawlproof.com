import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { parseSource, parseVisitorId, recordFunnelEvent } from "@/lib/funnel";

export const runtime = "nodejs";

// Browser beacon for the one funnel event only a browser can see: a person
// opening a report. Everything else is recorded server-side where it happens.
//
// Counted once per visitor per report per day, so reloads and the live
// poller's refreshes do not inflate it.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (body.event !== "report_viewed") return NextResponse.json({ ok: false }, { status: 400 });

  const token = typeof body.token === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(body.token) ? body.token : null;
  const visitorId = parseVisitorId(body.visitor_id);
  if (!token || !visitorId) return NextResponse.json({ ok: false }, { status: 400 });

  const svc = serviceClient();
  const { data: audit } = await svc
    .from("audits")
    .select("id, funnel_source")
    .eq("share_token", token)
    .maybeSingle();
  if (!audit) return NextResponse.json({ ok: false }, { status: 404 });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await svc
    .from("funnel_events")
    .select("id", { count: "exact", head: true })
    .eq("event", "report_viewed")
    .eq("audit_id", audit.id)
    .eq("visitor_id", visitorId)
    .gte("created_at", since);
  if ((count ?? 0) > 0) return NextResponse.json({ ok: true, dedup: true });

  // A link we sent says where the visit came from; otherwise the report's own
  // provenance (an outreach report opened without its ?src still came from
  // outreach), otherwise organic.
  const source =
    parseSource(body.source) ?? parseSource(audit.funnel_source) ?? "organic";

  await recordFunnelEvent({
    event: "report_viewed",
    source,
    visitorId,
    auditId: audit.id as string,
  });
  return NextResponse.json({ ok: true });
}
