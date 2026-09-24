// Email unsubscribe: /t/<trackingId>/u?m=&c=&e=<email>&s=<sig>
//
//   GET   a one-button confirmation page. Nothing is recorded: link scanners
//         and mail proxies fetch every URL in a message, and an unsubscribe
//         on GET would unsubscribe people who never clicked.
//   POST  records the unsubscribe. The same URL is the RFC 8058 one-click
//         target (List-Unsubscribe-Post: List-Unsubscribe=One-Click), so a
//         mail provider's own unsubscribe button lands here too.
//
// sig = first 32 hex of HMAC-SHA256(secret, lowercase(e)). An invalid sig is
// a 400 and records nothing. A valid one works whether or not tracking is
// enabled: honouring an unsubscribe is a legal duty, not a feature toggle.

import { NextResponse } from "next/server";
import {
  HTML_HEADERS,
  escapeHtml,
  htmlPage,
  isPlausibleTrackingId,
  normalizeEmail,
  tag,
  unsubscribeSigValue,
  verifySig,
} from "@/lib/emailTracking/core";
import { findByTrackingId, insertEvent, type TrackingRow } from "@/lib/emailTracking/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Checked =
  | { ok: true; row: TrackingRow; email: string; q: URLSearchParams }
  | { ok: false; res: NextResponse };

function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(htmlPage(title, body), { status, headers: HTML_HEADERS });
}

function invalid(): NextResponse {
  return page(
    "Unsubscribe link not valid",
    `<h1>This unsubscribe link is not valid</h1>
<p>The link may have been cut short or changed. Reply to the email you received and ask the sender to remove you.</p>`,
    400,
  );
}

async function check(req: Request, trackingId: string): Promise<Checked> {
  const q = new URL(req.url).searchParams;
  const rawE = q.get("e");
  const email = normalizeEmail(rawE);
  if (!email || !isPlausibleTrackingId(trackingId)) return { ok: false, res: invalid() };
  let row: TrackingRow | null;
  try {
    row = await findByTrackingId(trackingId);
  } catch {
    return {
      ok: false,
      res: page(
        "Try again",
        "<h1>Something went wrong</h1><p>We could not process this right now. Please try again in a minute.</p>",
        503,
      ),
    };
  }
  if (!row) return { ok: false, res: invalid() };
  if (!verifySig([row.secret, row.previous_secret], unsubscribeSigValue(rawE!), q.get("s"))) {
    return { ok: false, res: invalid() };
  }
  return { ok: true, row, email, q };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  const c = await check(req, trackingId);
  if (!c.ok) return c.res;
  // No action attribute: the form posts back to this exact URL, query and all.
  return page(
    "Unsubscribe",
    `<h1>Unsubscribe</h1>
<p>Stop emails from this sender to <strong>${escapeHtml(c.email)}</strong>?</p>
<form method="post">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">Unsubscribe</button>
</form>`,
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  const c = await check(req, trackingId);
  if (!c.ok) return c.res;
  try {
    await insertEvent({
      project_id: c.row.project_id,
      type: "unsubscribe",
      m: tag(c.q.get("m")),
      c: tag(c.q.get("c")),
      v: tag(c.q.get("v")),
      email: c.email,
    });
  } catch {
    // Saying "unsubscribed" when nothing was stored would be a lie with legal
    // weight. Ask for a retry instead.
    return page(
      "Try again",
      "<h1>Something went wrong</h1><p>Your unsubscribe was not saved. Please try again in a minute.</p>",
      503,
    );
  }
  return page(
    "You are unsubscribed",
    `<h1>You are unsubscribed</h1>
<p><strong>${escapeHtml(c.email)}</strong> has been unsubscribed from this sender&#39;s mail. You do not need to do anything else.</p>`,
  );
}
