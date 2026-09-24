// Email click redirect: GET /t/<trackingId>/c?u=<url>&m=&c=&v=&s=<sig>
//
// sig = first 32 hex of HMAC-SHA256(secret, u). Only a valid signature
// redirects, so this can never be used as an open redirect: anything else
// gets a small page with the link as plain text, for a person to judge.
// A valid link still redirects when tracking is off; it just is not counted.

import { NextResponse } from "next/server";
import {
  HTML_HEADERS,
  clientIp,
  escapeHtml,
  htmlPage,
  isMachineAgent,
  isPlausibleTrackingId,
  safeHttpUrl,
  tag,
  verifySig,
} from "@/lib/emailTracking/core";
import { findByTrackingId, insertEvent } from "@/lib/emailTracking/store";
import { hashIpRotating } from "@/lib/ipHash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unverified(raw: string | null, status: number): NextResponse {
  const shown = raw ? `<code>${escapeHtml(raw.slice(0, 2048))}</code>` : "";
  const body = raw
    ? `<h1>This link could not be verified</h1>
<p>We could not confirm who created this link, so we are not sending you there automatically. Here is where it points. Copy it into your browser only if you trust it.</p>${shown}`
    : `<h1>This link is incomplete</h1><p>There is no destination in this link.</p>`;
  return new NextResponse(htmlPage("Link not verified", body), { status, headers: HTML_HEADERS });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  const q = new URL(req.url).searchParams;
  const rawU = q.get("u");
  const target = safeHttpUrl(rawU);
  if (!target) return unverified(rawU, 400);

  let row: Awaited<ReturnType<typeof findByTrackingId>> = null;
  try {
    row = isPlausibleTrackingId(trackingId) ? await findByTrackingId(trackingId) : null;
  } catch {
    row = null;
  }
  // The signature covers u exactly as sent, not the normalised form.
  if (!row || !verifySig([row.secret, row.previous_secret], rawU!, q.get("s"))) {
    return unverified(rawU, 400);
  }

  if (row.enabled) {
    try {
      const now = new Date();
      await insertEvent({
        project_id: row.project_id,
        type: "click",
        m: tag(q.get("m")),
        c: tag(q.get("c")),
        v: tag(q.get("v")),
        url: target.slice(0, 2048),
        machine: isMachineAgent(req.headers.get("user-agent")),
        visitor_hash: hashIpRotating(clientIp(req.headers), now),
      });
    } catch {
      // A lost click is better than a dead link.
    }
  }

  return NextResponse.redirect(target, {
    status: 302,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}
