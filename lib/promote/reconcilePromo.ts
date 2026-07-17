// Reconcile a Promote (promo_post) row once its cookie-auth (browser) post
// settles in the Playwright worker.
//
// Cookie-auth posts are only *enqueued* by the sweep, which records the
// promo_post as 'pending' with a link to the sp_post (sp_post_id). The worker
// is where the post actually publishes or fails, so it's where we flip the
// promo_post to its real status, fill in the public post_url, and refund the
// credit for a post that never landed. No-op for sp_posts that didn't
// originate from Promote (no linked promo_post row).

import type { SupabaseClient } from "@supabase/supabase-js";

export async function reconcilePromo(
  supabase: SupabaseClient<any>,
  postId: string,
  outcome: "posted" | "failed",
  opts: { postUrl?: string | null; platformPostId?: string | null; error?: string | null } = {},
): Promise<void> {
  const { data: promo } = await supabase
    .from("promo_post")
    .select("id, status, credits_spent, promo_list(user_id)")
    .eq("sp_post_id", postId)
    .maybeSingle();
  if (!promo) return; // not a promote-originated post

  // Only reconcile a still-pending row (keeps this idempotent if it re-runs).
  if (promo.status !== "pending") return;

  if (outcome === "posted") {
    await supabase
      .from("promo_post")
      .update({
        status: "posted",
        post_url: opts.postUrl || null,
        external_post_id: opts.platformPostId || null,
        posted_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", promo.id);
    return;
  }

  // Failed: refund the up-front credit, then mark failed. Zeroing credits_spent
  // keeps the refund idempotent if this somehow re-runs.
  const spent = (promo.credits_spent as number | null) ?? 0;
  // PostgREST embeds a many-to-one relation as an object (or array in some
  // client typings) — normalize.
  const list = Array.isArray(promo.promo_list) ? promo.promo_list[0] : promo.promo_list;
  const ownerId = (list as { user_id?: string } | null)?.user_id;
  if (spent > 0 && ownerId) {
    await supabase.rpc("consume_credit", { p_owner: ownerId, p_count: -spent });
  }
  await supabase
    .from("promo_post")
    .update({ status: "failed", error: opts.error ?? null, credits_spent: 0 })
    .eq("id", promo.id);
}
