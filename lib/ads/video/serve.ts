// Resolving a chosen creative to the media a player can actually load.
//
// Selection, the auction and impression accounting are NOT redone here. They
// live in serveAd and are the same for a banner and a pre-roll: a second
// serving path would be a second set of numbers, and the one that is not
// wired to billing is the one that quietly gives inventory away.
//
// This module answers only the question serveAd cannot: given the creative it
// picked, which file should this player fetch?

import { env } from "@/lib/env";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GIF_PROFILE_IDS, type VideoProfileId } from "./profiles";

/** What the caller wants to play. A music player has nowhere to put a picture. */
export type StreamKind = "audio" | "video";

export type StreamMedia = {
  kind: StreamKind;
  url: string;
  durationMs: number | null;
  /** Shown before the first frame; null for an audio-only break. */
  posterUrl: string | null;
  /** WebVTT for the narration, when the revision has it. */
  captionsUrl: string | null;
  revision: number;
};

/**
 * Which profile serves which request.
 *
 * 720p rather than the 1080p master: the master is the download an advertiser
 * keeps, and making a viewer on a phone fetch it to watch five seconds is
 * spending their data on pixels their screen cannot show.
 */
const VIDEO_PROFILE: VideoProfileId = "mp4_720p";
const AUDIO_PROFILE: VideoProfileId = "audio";

/**
 * The media for a creative's published revision.
 *
 * Returns null rather than falling back to another revision or another
 * profile. A break that cannot be filled correctly should not happen at all —
 * every player in this system treats null as "play the content" — and a silent
 * fallback to an unpublished revision would serve media that was never
 * approved for serving.
 */
/**
 * The house pre-roll.
 *
 * A house ad is assembled in code from copy and artwork, so unlike a campaign
 * creative it has no render and nothing in the asset store to point a player
 * at. Every unsold break therefore came back empty, which is safe but means an
 * inventory slot that never plays anything at all.
 *
 * One bundled file rather than a render: the house pitch does not change per
 * fill the way a campaign's does, and giving it a render pipeline of its own
 * would be a second way to produce the same five seconds.
 */
const HOUSE_PREROLL = {
  path: "/ads/house/preroll.mp4",
  durationMs: 5000,
} as const;

export async function streamMediaFor(
  sb: SupabaseClient,
  args: { creativeId: string; kind: StreamKind; publicUrlFor: (objectKey: string) => string },
): Promise<StreamMedia | null> {
  // The house fill carries a literal id, not a row: looking it up in
  // ad_creatives finds nothing and empties the break.
  if (args.creativeId === "house") {
    return {
      // It carries a picture, so an audio-only surface is told what it is
      // getting rather than handed a video URL labelled as audio.
      kind: "video",
      url: `${env.siteUrl}${HOUSE_PREROLL.path}`,
      durationMs: HOUSE_PREROLL.durationMs,
      posterUrl: null,
      captionsUrl: null,
      revision: 1,
    };
  }

  // published_revision, not the newest: a revision becomes servable only when
  // the worker has validated it, and "newest" would serve a render that is
  // still being written.
  const { data: creative } = await sb
    .from("ad_creatives")
    .select("published_revision")
    .eq("id", args.creativeId)
    .maybeSingle();

  const revision = Number(creative?.published_revision ?? 0);
  if (!revision) return null;

  const { data: rows } = await sb
    .from("ad_video_assets")
    .select("profile, object_key, duration_ms, published")
    .eq("creative_id", args.creativeId)
    .eq("revision", revision)
    .eq("published", true);

  const assets = rows ?? [];
  const wanted = args.kind === "audio" ? AUDIO_PROFILE : VIDEO_PROFILE;
  const primary = assets.find((a) => a.profile === wanted);
  if (!primary) return null;

  const poster = assets.find((a) => a.profile === "poster");
  const captions = assets.find((a) => a.profile === "captions");

  return {
    kind: args.kind,
    url: args.publicUrlFor(primary.object_key as string),
    durationMs: primary.duration_ms === null ? null : Number(primary.duration_ms),
    // An audio break has nothing to show a poster on.
    posterUrl:
      args.kind === "video" && poster ? args.publicUrlFor(poster.object_key as string) : null,
    captionsUrl: captions ? args.publicUrlFor(captions.object_key as string) : null,
    revision,
  };
}

/**
 * The animated banners of a creative's published revision, by profile.
 *
 * Separate from the break media because a display slot asks a different
 * question: it wants a unit of a particular size, not "whatever plays".
 */
export async function animatedBannerFor(
  sb: SupabaseClient,
  args: {
    creativeId: string;
    profile: (typeof GIF_PROFILE_IDS)[number];
    publicUrlFor: (objectKey: string) => string;
  },
): Promise<{ url: string; revision: number } | null> {
  const { data: creative } = await sb
    .from("ad_creatives")
    .select("published_revision")
    .eq("id", args.creativeId)
    .maybeSingle();

  const revision = Number(creative?.published_revision ?? 0);
  if (!revision) return null;

  const { data: row } = await sb
    .from("ad_video_assets")
    .select("object_key")
    .eq("creative_id", args.creativeId)
    .eq("revision", revision)
    .eq("profile", args.profile)
    .eq("published", true)
    .maybeSingle();

  if (!row) return null;
  return { url: args.publicUrlFor(row.object_key as string), revision };
}
