// /api/ads/v1/slots — publisher slots for a bearer-token caller.
//
//   POST { site, placement?, formats?, format?, status?, enable_tracking? }
//        A slot on the site named by hostname or URL. The site's project is
//        found or created with the tracker on. Returns the slot with the two
//        tags to paste (`embed`, `tracker`). A site that already has a slot
//        gets that slot back, with `existing: true`.
//   GET  The caller's slots, newest first.
//
// Same auth as /api/ads/v1/campaigns. This is what `crawlproof slots` calls.

import { NextResponse, type NextRequest } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { authenticateBearer } from "@/lib/sp/apiAuth";
import { createSlotForSite, listSlots, parseSlotRequest } from "@/lib/ads/slots";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const siteUrl = () => (env.siteUrl || "https://crawlproof.com").replace(/\/$/, "");

export async function POST(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = parseSlotRequest(body ?? {});
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await createSlotForSite({ sb: serviceClient(), userId: auth.userId, request: parsed.request, siteUrl: siteUrl() });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.slot, { status: result.slot.existing ? 200 : 201 });
}

export async function GET(req: NextRequest) {
  const auth = await authenticateBearer(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const slots = await listSlots({ sb: serviceClient(), userId: auth.userId, siteUrl: siteUrl() });
  return NextResponse.json({ slots });
}
