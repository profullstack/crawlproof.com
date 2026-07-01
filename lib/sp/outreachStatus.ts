// Read-time reconciliation of recent-outreach history status.
//
// The recent_outreach_messages.status column is only accurate for the
// synchronous (OAuth) posting path. Cookie-auth posts are handed to the
// Playwright worker and recorded as "queued"; the worker updates the
// linked sp_post but never the outreach row. So we derive the real status
// from that sp_post when /recent renders — and expire browser jobs that
// never came back.

export type OutreachRowStatus = "sent" | "failed" | "queued";
export type OutreachDisplayStatus = "sent" | "failed" | "queued" | "timed_out";

export type OutreachSocialPost = {
  status: string | null;
  platform_post_url: string | null;
  last_error: string | null;
};

// How long a browser-automated post (auth_mode='cookie') may sit in the
// worker queue before we surface it as timed out. Playwright posts
// normally finish in well under a minute.
export const OUTREACH_STALE_MS = 20 * 60 * 1000;

export function deriveOutreachStatus(
  rowStatus: OutreachRowStatus,
  rowError: string | null,
  createdAt: string,
  post: OutreachSocialPost | null,
  now: number = Date.now(),
): { status: OutreachDisplayStatus; error: string | null } {
  // Terminal statuses from the synchronous path are authoritative.
  if (rowStatus !== "queued") return { status: rowStatus, error: rowError };
  // Manual "queued for hand-delivery" rows have no linked post.
  if (!post) return { status: "queued", error: rowError };

  if (post.status === "published") return { status: "sent", error: null };
  if (post.status === "failed" || post.status === "cancelled") {
    return { status: "failed", error: post.last_error ?? rowError };
  }
  // Still queued_browser / publishing — flip to timed out once stale.
  if (now - new Date(createdAt).getTime() > OUTREACH_STALE_MS) {
    return {
      status: "timed_out",
      error: "The worker never reported back — the post may not have been published.",
    };
  }
  return { status: "queued", error: rowError };
}
