// GET /api/v1/tracking/<trackingId>/events?since=<iso>&type=<open|click|unsubscribe>
//   Authorization: Bearer <tracking secret>
//
// How a sender (the myna CLI) pulls unsubscribes and A/B results. Returns
// { events: [{ type, m, c, v, url?, email?, machine?, at }], next }, oldest
// first. `next` is null on the last page, otherwise a URL to GET for the
// following page (it carries the same filters plus `cursor`). A client that
// prefers to build URLs itself can pass `cursor` from that URL.
//
// Works whether or not tracking is enabled: unsubscribes keep arriving after
// the owner switches tracking off, and the sender still has to honour them.

import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  isEventType,
  isPlausibleTrackingId,
  secretMatches,
  shapeEvent,
  type EmailEventType,
} from "@/lib/emailTracking/core";
import { findByTrackingId, listEvents, type EventRow } from "@/lib/emailTracking/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

function err(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  const token = bearer(req);
  if (!token) return err(401, "Missing Authorization: Bearer <tracking secret>.");
  if (!isPlausibleTrackingId(trackingId)) return err(401, "Invalid tracking id or secret.");

  let row: Awaited<ReturnType<typeof findByTrackingId>>;
  try {
    row = await findByTrackingId(trackingId);
  } catch {
    return err(503, "Temporarily unavailable.");
  }
  // Same answer for an unknown id and a wrong secret, so ids cannot be probed.
  if (!row || !secretMatches(row.secret, token)) return err(401, "Invalid tracking id or secret.");

  const url = new URL(req.url);
  const sp = url.searchParams;

  const sinceRaw = sp.get("since");
  let since: string | null = null;
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) return err(400, "since must be an ISO 8601 timestamp.");
    since = d.toISOString();
  }

  const typeRaw = sp.get("type");
  if (typeRaw !== null && !isEventType(typeRaw)) {
    return err(400, "type must be open, click or unsubscribe.");
  }
  const type: EmailEventType | null = typeRaw !== null && isEventType(typeRaw) ? typeRaw : null;

  const cursorRaw = sp.get("cursor");
  let afterId: number | null = null;
  if (cursorRaw) {
    if (!/^\d{1,18}$/.test(cursorRaw)) return err(400, "Invalid cursor.");
    afterId = Number(cursorRaw);
  }

  const limitRaw = Number(sp.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;

  let rows: EventRow[];
  try {
    rows = await listEvents({
      projectId: row.project_id,
      since,
      type,
      afterId,
      limit,
    });
  } catch {
    return err(503, "Temporarily unavailable.");
  }

  let next: string | null = null;
  if (rows.length === limit) {
    const n = new URL(`/api/v1/tracking/${trackingId}/events`, env.siteUrl || "https://crawlproof.com");
    if (since) n.searchParams.set("since", since);
    if (type) n.searchParams.set("type", type);
    n.searchParams.set("limit", String(limit));
    n.searchParams.set("cursor", String(rows[rows.length - 1].id));
    next = n.toString();
  }

  return NextResponse.json(
    { events: rows.map(shapeEvent), next },
    { headers: { "cache-control": "no-store" } },
  );
}
