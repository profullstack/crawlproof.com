// Which *presentation* a display fill is rendered as, and how one gets chosen.
//
// A publisher's slot names a SIZE (banner_300x250) and never a medium. That is
// deliberate and it is the whole point of this module: the 54 sites carrying a
// CrawlProof unit today pasted a div with a format on it, and none of them is
// going to be edited again to opt into motion. So the medium is picked here, per
// fill, out of whatever the winning campaign actually has rendered — and a site
// installed a year ago starts showing animated and video units the day the
// render pipeline produces them, with no embed change at all.
//
// Pure and client-safe, like ./formats: no Supabase, no node built-ins. The
// availability it is handed comes from the serving path; this module only
// decides what a box *can* carry and which of the candidates wins.

import type { AdFormatId } from "./formats";

/**
 * The media a display unit can be rendered as.
 *
 * 'static' — the code-drawn HTML creative on a brand wash. What every unit has
 *            always been, and the floor: it needs no rendered asset, so it is
 *            always a candidate and a slot can never go empty for want of media.
 * 'image'  — the same HTML creative with the hero artwork behind it.
 * 'gif'    — the animated banner rendition. The GIF is the whole unit (it is
 *            composed from the same design snapshot, copy and CTA included),
 *            so it replaces the markup rather than sitting inside it.
 * 'video'  — in-banner video: the muted, looping delivery MP4 with the copy
 *            and CTA beneath it.
 * 'audio'  — the static/image unit plus the audible companion on a native
 *            control. Click-to-play, never autoplay: sound a reader did not ask
 *            for is the one thing a publisher will pull the tag over.
 */
export const AD_MEDIA_KINDS = ["static", "image", "gif", "video", "audio"] as const;
export type AdMediaKind = (typeof AD_MEDIA_KINDS)[number];

export function isAdMediaKind(v: string | null | undefined): v is AdMediaKind {
  return !!v && (AD_MEDIA_KINDS as readonly string[]).includes(v);
}

/**
 * What each format's box can physically hold.
 *
 * This is a layout fact, not a policy, and the sizes genuinely differ:
 *
 *   * 300x250 is the only unit with room for all five. In-banner video gets a
 *     300x169 stage (16:9, the aspect every rendition is encoded at) and still
 *     leaves 81px for the copy line and the CTA, which is the standard
 *     in-banner video layout rather than something invented here.
 *   * 728x90 takes the hero as a right-hand plate and takes a GIF, but 90px
 *     cannot hold a 16:9 stage above a readable CTA — a 728-wide video would be
 *     410px tall. No ad network runs in-banner video at leaderboard height and
 *     neither does this one.
 *   * 320x50 has 50px. That is a line of copy and a button; there is no room
 *     for artwork behind it, a video stage, or an audio control. It rotates
 *     between the static unit and the animated one, which is the honest answer
 *     for the size.
 *   * text_link is a single 40px line by construction, and the terminal and
 *     feed units are text in somebody else's document. None of them has a
 *     medium to rotate.
 *
 * video_preroll_5s is absent on purpose: a streaming break is served as media
 * by /api/ads/stream, and it never comes through the display renderer at all.
 */
const MEDIA_BY_FORMAT: Partial<Record<AdFormatId, AdMediaKind[]>> = {
  banner_300x250: ["static", "image", "gif", "video", "audio"],
  banner_728x90: ["static", "image", "gif"],
  banner_320x50: ["static", "gif"],
};

/** The kinds this format's box could carry, if the assets existed. */
export function mediaKindsForFormat(format: AdFormatId): AdMediaKind[] {
  return MEDIA_BY_FORMAT[format] ?? ["static"];
}

/** Whether a format has more than one presentation, i.e. anything to rotate. */
export function rotatesMedia(format: AdFormatId): boolean {
  return mediaKindsForFormat(format).length > 1;
}

/**
 * The media URLs a fill has available, as resolved from the winning campaign's
 * rendered assets. Every field is independently nullable: a revision can carry
 * a 300x250 GIF and no audio, and a creative that was never rendered carries
 * nothing at all.
 */
export type MediaAssets = {
  /** The animated banner at this fill's exact size. */
  gifUrl: string | null;
  /** The delivery MP4. 16:9, so only usable where there is room for a stage. */
  videoUrl: string | null;
  /** First frame, shown before the video decodes — and instead of it if the
   *  publisher's CSP blocks media but not images. */
  posterUrl: string | null;
  /** The audible companion. */
  audioUrl: string | null;
};

export const NO_MEDIA: MediaAssets = {
  gifUrl: null,
  videoUrl: null,
  posterUrl: null,
  audioUrl: null,
};

/**
 * The kinds that are actually renderable for this fill.
 *
 * 'static' is unconditional — it needs nothing but the creative's own copy, so
 * the candidate list is never empty and rotation can never produce a blank
 * unit. Everything else has to have its bytes present.
 */
export function availableMediaKinds(args: {
  format: AdFormatId;
  hasImage: boolean;
  assets: MediaAssets;
}): AdMediaKind[] {
  const { format, hasImage, assets } = args;
  const canCarry = mediaKindsForFormat(format);
  const has = (k: AdMediaKind): boolean => {
    switch (k) {
      case "static":
        return true;
      case "image":
        return hasImage;
      case "gif":
        return Boolean(assets.gifUrl);
      case "video":
        return Boolean(assets.videoUrl);
      case "audio":
        // The companion rides on a unit that is drawn anyway, so it needs the
        // audio and nothing else.
        return Boolean(assets.audioUrl);
    }
  };
  return canCarry.filter(has);
}

/**
 * Narrow the candidates to a publisher's own preference, when they expressed one.
 *
 * Empty or absent means rotate over everything — that is the default, and it is
 * what every slot installed before this existed will keep saying. A mix that
 * names nothing available falls back to the full candidate list rather than to
 * an empty one: a publisher who allowed only video should get a static ad on
 * the fills where no video exists, not a hole in their page.
 */
export function applyMediaMix(
  candidates: AdMediaKind[],
  mix: readonly string[] | null | undefined,
): AdMediaKind[] {
  if (!Array.isArray(mix) || mix.length === 0) return candidates;
  const allowed = candidates.filter((k) => mix.includes(k));
  return allowed.length > 0 ? allowed : candidates;
}

/**
 * Pick one.
 *
 * Uniform over the candidates, deliberately. The reason to rotate at all is to
 * find out which medium a size actually converts in, and a weighted rotation
 * answers that question much more slowly — an even split is the fastest read of
 * five arms, and there is no prior worth encoding here yet. When there is one,
 * it belongs in a weight table with the measurement that justified it, not in a
 * guess made before any data existed.
 *
 * `rnd` is injectable so a test can assert the distribution instead of hoping.
 */
export function pickMediaKind(
  candidates: AdMediaKind[],
  rnd: () => number = Math.random,
): AdMediaKind {
  if (candidates.length === 0) return "static";
  const r = rnd();
  // Guard the ends: a generator that returns exactly 1 (or anything out of
  // range) must not index past the array and hand back undefined.
  const i = Math.min(candidates.length - 1, Math.max(0, Math.floor(r * candidates.length)));
  return candidates[i];
}

/**
 * The whole decision, in one call: what the box can hold, intersected with what
 * exists, narrowed by what the publisher allows, then one drawn at random.
 */
export function chooseMediaKind(args: {
  format: AdFormatId;
  hasImage: boolean;
  assets: MediaAssets;
  mix?: readonly string[] | null;
  rnd?: () => number;
}): AdMediaKind {
  const candidates = applyMediaMix(
    availableMediaKinds({ format: args.format, hasImage: args.hasImage, assets: args.assets }),
    args.mix,
  );
  return pickMediaKind(candidates, args.rnd);
}
