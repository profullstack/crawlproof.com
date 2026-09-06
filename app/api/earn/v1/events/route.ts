// POST /api/earn/v1/events { action, campaign_id?, slot_id?, dwell_ms? }
//
// One engagement, offered for reward. Every limit that decides whether it pays
// is applied inside earn_award() rather than here, because this endpoint is
// reachable from a browser and that function is not.
//
// A refusal is still a 200 with `accepted: false` and a reason. "Why am I not
// earning" is the first question a reader asks, and answering it with an error
// code teaches them nothing.

import { NextResponse, type NextRequest } from "next/server";
import { clientIpFromHeaders } from "@/lib/tracker/geo";
import { hashIpRotating } from "@/lib/ipHash";
import { resolveParty } from "@/lib/earn/accounts";
import { award } from "@/lib/earn/rail";
import { cleanDwell, formatMicros, isEarnAction } from "@/lib/earn/rates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const party = await resolveParty(req);
  if (!party.ok) return NextResponse.json({ error: party.error }, { status: party.status });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const action = body.action;
  if (!isEarnAction(action)) {
    return NextResponse.json(
      { error: "action must be one of read, respond, follow." },
      { status: 400 },
    );
  }

  const uuid = (v: unknown): string | null => {
    const s = String(v ?? "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
  };

  const result = await award({
    accountId: party.account.id,
    action,
    campaignId: uuid(body.campaign_id),
    slotId: uuid(body.slot_id),
    // Rotates daily, which is exactly the window the caps are counted over,
    // and is null for an unattributable request rather than bucketing every
    // one of them under a shared constant.
    ipHash: hashIpRotating(clientIpFromHeaders(req.headers)),
    dwellMs: cleanDwell(body.dwell_ms),
  });

  return NextResponse.json({
    accepted: result.accepted,
    reward_micros: result.rewardMicros,
    reward: formatMicros(result.rewardMicros),
    reason: result.reason,
    event_id: result.eventId,
  });
}
