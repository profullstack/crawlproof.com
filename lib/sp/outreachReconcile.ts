// Reconcile the recent-outreach history row once a cookie-auth (browser)
// post settles in the worker.
//
// Outreach charges a credit up front, but a cookie-auth post is only
// *enqueued* at that point — the actual send succeeds or fails later in the
// Playwright worker. So the worker is where we refund the credit for a send
// that never landed and flip the history row to its real status. This is a
// no-op for posts that didn't originate from outreach (no linked row).

import type { SupabaseClient } from "@supabase/supabase-js";

export async function reconcileOutreach(
  supabase: SupabaseClient<any>,
  postId: string,
  outcome: "sent" | "failed",
  errorMessage: string | null,
): Promise<void> {
  const { data: msg } = await supabase
    .from("recent_outreach_messages")
    .select("id, sender_id, credits_spent, status")
    .eq("social_post_id", postId)
    .maybeSingle();
  if (!msg) return;

  if (outcome === "sent") {
    if (msg.status === "queued") {
      await supabase
        .from("recent_outreach_messages")
        .update({ status: "sent", error: null })
        .eq("id", msg.id);
    }
    return;
  }

  // Refund the up-front credit for a failed send, then mark it failed.
  // Zeroing credits_spent keeps the refund idempotent if this ever re-runs.
  const spent = (msg.credits_spent as number | null) ?? 0;
  if (spent > 0 && msg.sender_id) {
    await refundOutreachCredit(supabase, msg.sender_id as string, spent);
  }
  await supabase
    .from("recent_outreach_messages")
    .update({ status: "failed", error: errorMessage, credits_spent: 0 })
    .eq("id", msg.id);
}

// Best-effort read-then-write refund, mirroring the worker's inline
// refundCredits and the recent-outreach action's refundCredits path.
async function refundOutreachCredit(
  supabase: SupabaseClient<any>,
  ownerId: string,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  const { data: prof } = await supabase
    .from("profiles")
    .select("credits_balance")
    .eq("id", ownerId)
    .maybeSingle();
  if (!prof) return;
  await supabase
    .from("profiles")
    .update({ credits_balance: (prof.credits_balance ?? 0) + count })
    .eq("id", ownerId);
}
