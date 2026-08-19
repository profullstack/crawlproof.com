// Choosing, without a human, which slot becomes a guest post and where it goes.
//
// Guest posting was a manual loop: open the project, read the ranked
// opportunities, pick a partner, pick one of the crossed topics, click. Every
// piece of judgement in that loop is already computed — `findGuestPostOpportunities`
// ranks the partners and crosses the seed keywords — so what the click actually
// contributed was a decision to proceed and a choice of the top item. This makes
// both automatic and puts them on the publishing schedule.
//
// Two things are deliberately *not* automated here, because they are the parts
// where being wrong is expensive:
//
//   * **Nothing is published to a site outside the network.** A target has to be
//     `backlinks_enabled`, `active` and not flagged for inappropriate content —
//     the same filter the manual matcher applies. Partners opted in to receiving
//     guest posts; strangers did not.
//   * **A slot is never wasted on a failed guest post.** If there is no partner,
//     no usable topic, or the author has recently written for everyone
//     available, the caller falls back to an ordinary article. The publishing
//     cadence a customer is paying for comes first.

import type { SupabaseClient } from "@supabase/supabase-js";
import { findGuestPostOpportunities } from "./guestPostMatcher";
import { subjectFromTopicFeeds } from "./feedTopics";

/**
 * One in every this many published posts is a guest post.
 *
 * Ten because it is the ratio that keeps guest posting a *supplement* to a
 * site's own blog rather than a redirect of it: nine posts still land on the
 * author's own domain, building the thing the customer is actually paying to
 * grow, and the tenth buys a contextual backlink from a partner. Raising it
 * dilutes the author's own output; lowering it makes the partner network look
 * like a link farm to anybody reading it, which it must not become.
 */
export const GUEST_POST_EVERY = 10;

/**
 * Don't write for the same partner again inside this window.
 *
 * A network of a dozen partners and a daily schedule would otherwise send the
 * top-ranked partner a post every ten days for ever, because ranking is stable —
 * the matcher has no memory. Thirty days spreads the output across the network
 * and stops any one partner's blog filling up with our bylines, which is the
 * shape that gets a link network discounted.
 */
const PARTNER_COOLDOWN_DAYS = 30;

export type GuestPostPlan = {
  targetSiteId: string;
  targetDomain: string;
  topic: string;
};

/**
 * Is the next post this site publishes due to be a guest post?
 *
 * Counted from articles already on file rather than from a counter column, so
 * it is self-correcting: a failed generation, a manual post or a restored
 * backup all move the count, and the cadence follows the reality rather than a
 * number somebody has to remember to increment. Guest posts count toward the
 * ten themselves — "every 10th post" is every 10th post, not every 10th
 * own-blog post plus extras.
 *
 * @returns true when the next article would be the 10th, 20th, ...
 */
export async function isGuestPostSlot(
  supabase: SupabaseClient<any>,
  authorSiteId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("lx_article")
    .select("id", { count: "exact", head: true })
    .eq("site_id", authorSiteId);

  // A failed count must not silently turn every slot into a guest post, nor
  // silently turn none of them into one. Falling back to "no" keeps the
  // customer's own blog publishing, which is the obligation that matters.
  if (error) {
    console.warn("[lx] guest-post cadence count failed:", error.message);
    return false;
  }

  return ((count ?? 0) + 1) % GUEST_POST_EVERY === 0;
}

/**
 * Pick a partner and a topic, or return null and let the caller publish
 * normally.
 *
 * The ranking is the matcher's; the only judgement added here is skipping
 * partners written for recently, which the matcher cannot know about because it
 * is stateless by design.
 *
 * @param supabase service client — this runs from cron, with no user session
 * @param authorSiteId the site whose slot is being filled
 */
export async function planGuestPost(
  supabase: SupabaseClient<any>,
  authorSiteId: string,
): Promise<GuestPostPlan | null> {
  const opportunities = await findGuestPostOpportunities(supabase, authorSiteId).catch(
    (err: unknown) => {
      console.warn("[lx] guest-post matcher failed:", err);
      return [];
    },
  );
  if (opportunities.length === 0) return null;

  const since = new Date(
    Date.now() - PARTNER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Who we have written for lately. One query for the whole cooldown rather
  // than one per candidate: the list is short and the cron is walking every
  // active site.
  const { data: recent } = await supabase
    .from("lx_article")
    .select("target_site_id")
    .eq("site_id", authorSiteId)
    .eq("is_guest_post", true)
    .gte("created_at", since);

  const cooling = new Set(
    (recent ?? [])
      .map((r: { target_site_id: string | null }) => r.target_site_id)
      .filter((id: string | null): id is string => Boolean(id)),
  );

  // Topics already requested for a partner, so a repeat run does not queue the
  // same article twice. `lx_guest_post_request` is the manual path's ledger and
  // is reused rather than duplicated — a human and the cron should not be able
  // to commission the same post independently.
  const { data: existing } = await supabase
    .from("lx_guest_post_request")
    .select("target_site_id, topic")
    .eq("author_site_id", authorSiteId);

  const taken = new Set(
    (existing ?? []).map(
      (r: { target_site_id: string; topic: string }) =>
        `${r.target_site_id}::${r.topic.trim().toLowerCase()}`,
    ),
  );

  for (const opportunity of opportunities) {
    if (cooling.has(opportunity.partner_site_id)) continue;

    const topic = (opportunity.suggested_topics ?? []).find(
      (t) => t && !taken.has(`${opportunity.partner_site_id}::${t.trim().toLowerCase()}`),
    );
    if (!topic) continue;

    return {
      targetSiteId: opportunity.partner_site_id,
      targetDomain: opportunity.partner_domain,
      topic,
    };
  }

  // Every partner is either cooling off or has had all its crossed topics used.
  //
  // The crossings are finite — they are combinations of two fixed keyword
  // lists — so a partner written for a few times exhausts them and the slot
  // falls back to the author's own blog for ever after. Before giving up, take
  // a subject from what the small web is actually publishing: a real post from
  // an RSS Amplifier topic feed, picked at random, which the generator then
  // writes a full article about. Nothing is copied; what the feed contributes
  // is a subject somebody genuinely cared about this week rather than one
  // assembled from two keyword lists.
  for (const opportunity of opportunities) {
    if (cooling.has(opportunity.partner_site_id)) continue;

    const found = await subjectFromTopicFeeds(
      // The partner's own suggested topics are the best guide to what their
      // readers came for, and they are already crossed against ours.
      opportunity.suggested_topics ?? [],
    );
    if (!found) continue;

    const key = `${opportunity.partner_site_id}::${found.subject.trim().toLowerCase()}`;
    if (taken.has(key)) continue;

    return {
      targetSiteId: opportunity.partner_site_id,
      targetDomain: opportunity.partner_domain,
      topic: found.subject,
    };
  }

  // Nothing anywhere. A healthy network doing its job rather than an error —
  // the caller publishes to the author's own blog instead.
  return null;
}
