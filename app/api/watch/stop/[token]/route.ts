import { NextResponse } from "next/server";
import { stopWatchByToken } from "@/app/actions/watchScan";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// RFC 8058 one-click unsubscribe. Both List-Unsubscribe and
// List-Unsubscribe-Post must name the SAME URL, and mail clients issue a POST
// to it — which a page route can't answer. So this is the URL in the headers:
// a POST performs the stop and returns 200, a GET (a human clicking the link
// in the footer) redirects to the page that explains what happened.

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  await stopWatchByToken(token);
  // Always 200, even for an unknown token: the sender must not be able to
  // learn which tokens are live by watching status codes.
  return NextResponse.json({ ok: true });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const base = env.siteUrl.replace(/\/$/, "");
  return NextResponse.redirect(`${base}/watch/stop/${encodeURIComponent(token)}`, 302);
}
