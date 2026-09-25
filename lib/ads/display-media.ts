// Resolving a display fill to the rendered media it could be shown as.
//
// The asset store is keyed on the creative that owns the render, and that is
// never the banner creative serveAd just picked: `ad_creatives_revision_check`
// confines requested/published_revision to `video_preroll_5s`, so every
// rendition of a campaign — the MP4s, the poster, the audible companion AND the
// three animated banners — hangs off the campaign's ONE video creative. A
// display fill therefore has to look sideways at its campaign's sibling, not
// down at itself. Querying ad_video_assets by the banner's own id finds nothing,
// which reads exactly like "this campaign has no motion" and is why the
// animated banners sat rendered and unserved.
//
// Everything here is best-effort by construction. This runs inside the serving
// path, where the only unacceptable outcome is an empty unit: a failed lookup,
// an absent table, a column a hand-applied migration has not reached yet all
// return "no media", and the fill renders as the static or hero unit it would
// have been yesterday.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdFormatId } from "./formats";
import { NO_MEDIA, type MediaAssets } from "./media";
import { VIDEO_FORMAT_ID } from "./formats";

/**
 * The animated banner profile that matches a display size.
 *
 * Deliberately exact rather than nearest: a 728x90 slot handed the 300x250 GIF
 * would be a unit with two thirds of the box empty, and scaling a 40-frame GIF
 * is a blurry version of a file that was composed at native size precisely so
 * it would not have to be.
 */
const GIF_PROFILE_BY_FORMAT: Partial<Record<AdFormatId, string>> = {
  banner_300x250: "gif_300x250",
  banner_728x90: "gif_728x90",
  banner_320x50: "gif_320x50",
};

/**
 * The MP4 rendition in-banner video uses.
 *
 * 480p, not the 720p the streaming break plays: the stage inside a 300x250 is
 * 300px wide, so 720p spends four times the bytes on pixels that get thrown
 * away before the first frame is painted — and a display unit is competing with
 * the page's own content for the same connection.
 */
const IN_BANNER_VIDEO_PROFILE = "mp4_480p";
const POSTER_PROFILE = "poster";
const AUDIO_PROFILE = "audio";

type AssetRow = {
  profile: string | null;
  object_key: string | null;
  revision: number | null;
  published: boolean | null;
};

/**
 * What the campaign behind this fill has rendered, as URLs for this format.
 *
 * One round trip: the sibling video creative and its assets come back as a
 * nested select, and the revision filter is applied here rather than in the
 * query so that `published_revision` — which is what makes a revision servable
 * at all — is read from the same row that carries the assets.
 */
export async function displayMediaFor(
  sb: SupabaseClient,
  args: {
    campaignId: string;
    format: AdFormatId;
    publicUrlFor: (objectKey: string) => string;
  },
): Promise<MediaAssets> {
  const gifProfile = GIF_PROFILE_BY_FORMAT[args.format];
  // Nothing on this format can be anything but markup, so do not spend a query
  // discovering that.
  if (!gifProfile) return NO_MEDIA;

  try {
    const { data, error } = await sb
      .from("ad_creatives")
      .select("published_revision, ad_video_assets(profile, object_key, revision, published)")
      .eq("campaign_id", args.campaignId)
      .eq("format", VIDEO_FORMAT_ID)
      .maybeSingle();

    if (error || !data) return NO_MEDIA;

    // published_revision, not the newest: a revision becomes servable only once
    // the worker has validated it, and "newest" would serve a render that is
    // still being written. Same rule as streamMediaFor — one revision pointer,
    // read the same way on both paths.
    const revision = Number((data as { published_revision?: number | null }).published_revision ?? 0);
    if (!revision) return NO_MEDIA;

    const rows = (data as { ad_video_assets?: AssetRow[] | AssetRow | null }).ad_video_assets;
    const assets = (Array.isArray(rows) ? rows : rows ? [rows] : []).filter(
      (a) => a && a.published === true && Number(a.revision) === revision && a.object_key,
    );

    const keyFor = (profile: string): string | null => {
      const row = assets.find((a) => a.profile === profile);
      return row?.object_key ?? null;
    };
    const urlFor = (profile: string): string | null => {
      const key = keyFor(profile);
      return key ? args.publicUrlFor(key) : null;
    };

    return {
      gifUrl: urlFor(gifProfile),
      videoUrl: urlFor(IN_BANNER_VIDEO_PROFILE),
      posterUrl: urlFor(POSTER_PROFILE),
      audioUrl: urlFor(AUDIO_PROFILE),
    };
  } catch {
    // See the module note: a display unit must never fail because its optional
    // media could not be resolved.
    return NO_MEDIA;
  }
}

/**
 * A slot's media allow-list, or null for "rotate over everything".
 *
 * A separate query rather than three more columns on serveAd's slot select, and
 * for the reason that select's own comments give: migrations here are applied by
 * hand, so naming a column that a deploy has run ahead of would fail the query
 * that decides whether ANY unit on ANY slot renders. A publisher preference is
 * not worth that blast radius, so it is read where a failure means "no
 * preference stated" and nothing more.
 */
export async function slotMediaMix(
  sb: SupabaseClient,
  slotId: string,
): Promise<string[] | null> {
  try {
    const { data, error } = await sb
      .from("ad_slots")
      .select("media_mix")
      .eq("id", slotId)
      .maybeSingle();
    if (error || !data) return null;
    const mix = (data as { media_mix?: unknown }).media_mix;
    if (!Array.isArray(mix)) return null;
    const cleaned = mix.filter((m): m is string => typeof m === "string" && m.length > 0);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}
