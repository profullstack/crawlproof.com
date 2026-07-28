import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { scanAllMailboxes } from "@/lib/outreach/replyScan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// IMAP is a conversation, not a request: connect, authenticate, select, fetch.
// A busy mailbox on a slow server can take a while and the default budget is
// not generous enough to finish.
export const maxDuration = 300;

/**
 * Read the connected mailboxes and mark who replied.
 *
 * Everything past "contacted" used to depend on a human marking it, which
 * means anyone who did not got a reply rate of structurally zero — a number
 * that reads as a verdict on the campaign when it is really a verdict on the
 * bookkeeping.
 *
 * Auto-replies are recorded and flagged rather than counted. An out-of-office
 * is a real fact about the recipient and not an answer to the pitch.
 */
export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const results = await scanAllMailboxes();

  return NextResponse.json({
    ok: true,
    mailboxes: results.length,
    scanned: results.reduce((n, r) => n + r.scanned, 0),
    replies: results.reduce((n, r) => n + r.matched, 0),
    autoReplies: results.reduce((n, r) => n + r.autoReplies, 0),
    // Per mailbox, so one broken credential is visible rather than being
    // averaged into an otherwise healthy total.
    results,
  });
}
