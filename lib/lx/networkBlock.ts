// What a published article carries besides the article: an ad unit, and links
// out to the rest of the network.
//
// Both are governed by one column — `lx_site.ads_enabled`, default true — and
// that is deliberate. Splitting "show ads" from "join the link network" into
// two switches produces four states, two of which are incoherent (take
// backlinks from partners, refuse to give them) and all four of which need a
// human to reason about. One switch, on by default, is the whole opt-in.
//
// Three things this is careful about.
//
// **The slot is provisioned, not requested.** A blog with no ad slot used to
// mean a support conversation. Slots are created here, active, on first
// delivery — `ad_slots.status` defaults to 'inactive' and `serveAd()` returns
// null before the house-ad fallback for a non-active slot, so a slot created
// at the default would render an empty div on every article forever and look
// exactly like a broken embed. Provisioning it inactive would be worse than
// not provisioning it at all.
//
// **Everything interpolated is escaped.** The titles and links in the
// insertion block come from other people's RSS feeds. They are written into
// HTML that lands on a customer's domain, which makes this an injection sink
// with a hostile upstream, and the fact that the immediate source is our own
// directory changes nothing about that — the directory is a crawl of the open
// web.
//
// **A failure here costs the block, never the article.** Every lookup is
// wrapped and degrades to "no block". A post that publishes without an ad unit
// has cost us an impression; a post that fails to publish because the ad
// lookup threw has cost the customer the thing they are paying for.

import type { SupabaseClient } from "@supabase/supabase-js";
import { postsFromTopicFeeds } from "./feedTopics";

/** Format asked of the slot. 728x90 is the in-article leaderboard. */
const AD_FORMAT = "banner_728x90";

/** Most partner links in one insertion. */
const MAX_PARTNER_LINKS = 3;

/** Most directory posts in one insertion. */
const MAX_FEED_LINKS = 3;

/**
 * Escape text for HTML interpolation.
 *
 * Ampersand first, or the escapes introduced by the later replacements get
 * double-escaped. Quotes are included because these values are also written
 * into attributes.
 */
export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Is this a link we are willing to put on a customer's page?
 *
 * An allowlist of two schemes rather than a denylist of the dangerous ones:
 * `javascript:`, `data:` and `vbscript:` are the ones anybody thinks to block,
 * and the list of what else a browser will execute is not one to maintain by
 * hand.
 */
export function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export type NetworkLink = { title: string; url: string; source: "partner" | "directory" };

/**
 * The slot this project's articles should fill.
 *
 * Reuses an existing active slot before creating one, so re-delivering an
 * article — or publishing the second post on a blog — does not mint a second
 * slot and split the site's reporting across two rows.
 *
 * @returns a slot id, or null when one could not be resolved or created
 */
export async function resolveAdSlot(
  supabase: SupabaseClient<any>,
  projectId: string,
  ownerId: string,
  niche: string | null,
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from("ad_slots")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (existing?.id) return existing.id;

    const { data: created } = await supabase
      .from("ad_slots")
      .insert({
        project_id: projectId,
        owner_id: ownerId,
        placement: "inline",
        formats: [AD_FORMAT, "banner_300x250", "text_link"],
        niche,
        // Explicit, against the column default. See the note at the top of
        // this file: an inactive slot is indistinguishable from a broken one.
        status: "active",
      })
      .select("id")
      .maybeSingle<{ id: string }>();
    return created?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The ad unit markup.
 *
 * `data-cp-ad` carries no `data-slot` in the server-rendered case elsewhere in
 * the codebase to avoid a fill race; here there is no client to race with —
 * this HTML is delivered to a third-party blog and rendered as-is — so the
 * slot travels on the element and ad.js's own DOMContentLoaded pass fills it.
 */
export function adUnitHtml(slotId: string, origin: string): string {
  const slot = escapeHtml(slotId);
  const src = `${origin.replace(/\/$/, "")}/ad.js`;
  return [
    `<div data-cp-ad data-slot="${slot}" data-format="${AD_FORMAT}"></div>`,
    `<script async src="${escapeHtml(src)}"></script>`,
  ].join("\n");
}

/**
 * The "elsewhere in the network" block.
 *
 * Partner articles first, directory posts after: a partner opted into the
 * exchange and gets the more valuable position, while the directory posts are
 * what keep the block from being visibly the same three domains on every
 * article — which is the shape that gets a link network discounted.
 *
 * Directory links are `rel="nofollow ugc"`. They are not exchange partners and
 * have not agreed to anything; passing them ranking signal would be us
 * spending someone else's reputation. Partner links are followed, because that
 * reciprocity is the entire point of the exchange and is recorded on both
 * sides in lx_backlink.
 */
export function networkLinksHtml(links: NetworkLink[]): string {
  const safe = links.filter((l) => isSafeHref(l.url));
  if (safe.length === 0) return "";

  const items = safe
    .map((link) => {
      const rel = link.source === "directory"
        ? ' rel="nofollow ugc noopener"'
        : ' rel="noopener"';
      return `  <li><a href="${escapeHtml(link.url)}"${rel}>${escapeHtml(link.title)}</a></li>`;
    })
    .join("\n");

  return [
    `<aside class="cp-network-links" data-cp-network>`,
    `  <h2>Elsewhere on this topic</h2>`,
    `  <ul>`,
    items,
    `  </ul>`,
    `</aside>`,
  ].join("\n");
}

/**
 * Everything appended to an article, for a site that is in the network.
 *
 * @param supabase service client — this runs from the delivery path, no session
 * @param site the blog that will HOST the post (the guest-post target, when
 *        the article is one), because it is that site's readers who see the
 *        block and that site's owner who opted in
 * @param topics subjects to pull directory posts for
 * @param partnerLinks already-ranked exchange candidates from the caller
 * @returns HTML to append, or "" when the site is opted out or nothing resolved
 */
export async function buildNetworkBlock(
  supabase: SupabaseClient<any>,
  site: {
    id: string;
    project_id: string;
    user_id: string;
    niche: string | null;
    ads_enabled?: boolean | null;
  },
  topics: string[],
  partnerLinks: NetworkLink[],
  origin: string,
): Promise<string> {
  // Absent column reads as opted in, matching the migration default, so this
  // behaves the same before and after the schema lands.
  if (site.ads_enabled === false) return "";

  const parts: string[] = [];

  const feedLinks: NetworkLink[] = await postsFromTopicFeeds(topics, MAX_FEED_LINKS)
    .then((posts) =>
      posts.map((p) => ({ title: p.title, url: p.link, source: "directory" as const })),
    )
    .catch(() => []);

  const block = networkLinksHtml([
    ...partnerLinks.slice(0, MAX_PARTNER_LINKS),
    ...feedLinks,
  ]);
  if (block) parts.push(block);

  const slotId = await resolveAdSlot(
    supabase,
    site.project_id,
    site.user_id,
    site.niche,
  );
  if (slotId) parts.push(adUnitHtml(slotId, origin));

  return parts.join("\n");
}
