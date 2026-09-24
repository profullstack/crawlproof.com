// Turning a generated design into a render job.
//
// This is the seam between the ad pipeline the dashboard already has and the
// encoder package B built. Everything here is written so that a video render
// can fail, stall, or be unavailable entirely without any of it reaching the
// advertiser's campaign: a render is an additional output of saving a campaign,
// never a precondition for one.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyCampaign } from "./classify";
import type { AdCreative } from "../formats";
import { VIDEO_FORMAT_ID } from "../formats";
import { MAX_HEADLINE_WORDS, renderHash, validateSnapshot, type VideoDesignSnapshot } from "./snapshot";
import { enqueueRender } from "./queue";
import { VIDEO_PROFILES, type VideoProfileId, GIF_PROFILE_IDS} from "./profiles";

/** The one output profile a job is keyed on; a job renders the whole set. */
export const DEFAULT_OUTPUT_PROFILE = "default";

export type RenderState = "queued" | "rendering" | "validating" | "ready" | "failed";

/**
 * Clip a display headline down to something a five-second ad can hold.
 *
 * Display headlines are capped at 48 characters, which is a different
 * constraint entirely: a banner can set eight words in two lines and still
 * read, where a pre-roll has to be legible at 480p from across a room in about
 * three seconds. Clipping on a word boundary rather than mid-word, and
 * returning the original when it already fits, means most campaigns are
 * unaffected and the ones that aren't lose a trailing clause rather than half
 * a word.
 */
/**
 * How many times one design may be re-attempted.
 *
 * A render can fail for a reason that will never change, and the row is keyed
 * by the design rather than by the attempt, so without a cap every save of an
 * unrenderable campaign would queue the same doomed work again.
 */
export const MAX_RENDER_ATTEMPTS = 3;

export function trimHeadlineForVideo(headline: string): string {
  const words = headline.trim().split(/\s+/).filter(Boolean);
  if (words.length <= MAX_HEADLINE_WORDS) return words.join(" ");
  return words.slice(0, MAX_HEADLINE_WORDS).join(" ");
}

/**
 * Build the render input from the design the generator already produced.
 *
 * Deliberately derived from an existing creative rather than generated afresh:
 * the video must make the same claim, in the same palette, as the display ads
 * the advertiser reviewed and approved. A separate generation pass would drift,
 * and a campaign whose banner and pre-roll say different things is a
 * compliance problem rather than a design inconsistency.
 *
 * The medium rectangle is preferred as the source because it carries the full
 * headline and the hero artwork. banner_320x50 is avoided for the same reason
 * the feed backfill avoids it — it holds the *shortened* mobile headline, and a
 * 1920x1080 frame has no width problem that would justify truncated copy.
 */
export function snapshotFromCreatives(args: {
  creatives: Pick<
    AdCreative,
    "format" | "headline" | "body" | "ctaText" | "bgColor" | "fgColor" | "accentColor" | "fontFamily" | "logoUrl" | "imageUrl"
  >[];
  domain: string;
  locale?: string;
  reducedMotion?: boolean;
}): VideoDesignSnapshot | null {
  const preference: string[] = [
    "banner_300x250",
    "banner_728x90",
    "text_link",
    "terminal_ascii",
    "feed_item",
    "banner_320x50",
  ];
  const source = preference
    .map((f) => args.creatives.find((c) => c.format === f))
    .find((c): c is NonNullable<typeof c> => !!c);
  if (!source) return null;

  return {
    headline: trimHeadlineForVideo(source.headline),
    // The animated banners show this as their second line, matching the static
    // unit. The pre-roll ignores it: five seconds of 1920x1080 is a headline
    // and a CTA, and a body line there is copy nobody reads.
    subhead: (source.body ?? "").trim() || null,
    ctaText: source.ctaText || "Learn more",
    domain: args.domain,
    bgColor: source.bgColor,
    fgColor: source.fgColor,
    accentColor: source.accentColor,
    fontFamily: source.fontFamily,
    logoUrl: source.logoUrl ?? null,
    // Package C does not fetch and hash the artwork yet, so the compositor
    // renders its accent-tinted fallback rather than the hero. Recording the
    // URL with a null content hash would be worse than recording neither: the
    // hash is what the dedupe key trusts, and a null one alongside a real URL
    // invites a later change to treat the URL as sufficient.
    logoSha256: null,
    heroUrl: null,
    heroSha256: null,
    audioMode: "silent",
    narration: null,
    locale: args.locale ?? "en",
    reducedMotion: args.reducedMotion ?? false,
  };
}

export type RenderHandle = {
  jobId: string;
  state: RenderState;
  revision: number;
  /** True when an identical design already had a job; no new work was queued. */
  reused: boolean;
  /** False when Redis is unavailable — the row exists and a sweep can pick it up. */
  enqueued: boolean;
};

type EnsureArgs = {
  ownerId: string;
  /** Null for a preview render started before any campaign exists. */
  campaignId: string | null;
  creativeId: string | null;
  snapshot: VideoDesignSnapshot;
  revision: number;
  audioSlotSupported?: boolean;
};

/**
 * Create a render job for this design, or hand back the one that already
 * exists.
 *
 * Dedupe is on the render hash rather than on the campaign, so the same design
 * previewed twice, saved, and then regenerated without edits is one encode.
 * The unique index on (render_hash, output_profile) is what makes that true
 * under concurrency; the select-then-insert below is the fast path, and the
 * conflict re-select is the correct one.
 */
export async function ensureRenderJob(
  supabase: SupabaseClient,
  args: EnsureArgs,
): Promise<RenderHandle | { error: string }> {
  const problems = validateSnapshot(args.snapshot);
  if (problems.length > 0) {
    return { error: problems.map((p) => `${p.field}: ${p.reason}`).join(", ") };
  }

  const hash = renderHash(args.snapshot, DEFAULT_OUTPUT_PROFILE as VideoProfileId);

  const existing = await supabase
    .from("ad_video_jobs")
    .select("id, state, revision, attempts")
    .eq("render_hash", hash)
    .eq("output_profile", DEFAULT_OUTPUT_PROFILE)
    .maybeSingle();

  if (existing.data) {
    // A failed job must not become a permanent verdict on a design. Dedupe
    // handed the failed row straight back, so once a render failed, that exact
    // copy could never render again: re-saving hit the same hash, and the card
    // telling the advertiser to edit and retry was advice that could not work.
    //
    // Capped, because the failure may be deterministic — a snapshot this
    // renderer simply cannot draw — and an uncapped retry would re-run it on
    // every save forever.
    const state = existing.data.state as RenderState;
    const attempts = Number(existing.data.attempts ?? 0);
    if (state === "failed" && attempts < MAX_RENDER_ATTEMPTS) {
      await supabase
        .from("ad_video_jobs")
        .update({ state: "queued", error_code: null })
        .eq("id", existing.data.id as string);
      const requeued = await enqueueRender({
        renderHash: hash,
        profile: DEFAULT_OUTPUT_PROFILE,
        data: {
          jobRowId: existing.data.id as string,
          ownerId: args.ownerId,
          campaignId: args.campaignId ?? null,
          creativeId: args.creativeId ?? null,
          revision: existing.data.revision as number,
          snapshot: args.snapshot,
          profile: DEFAULT_OUTPUT_PROFILE,
          audioSlotSupported: false,
        },
      }).catch(() => false);
      return {
        jobId: existing.data.id as string,
        state: "queued" as RenderState,
        revision: existing.data.revision as number,
        reused: true,
        enqueued: requeued,
      };
    }
    return {
      jobId: existing.data.id as string,
      state: existing.data.state as RenderState,
      revision: existing.data.revision as number,
      reused: true,
      enqueued: true,
    };
  }

  const inserted = await supabase
    .from("ad_video_jobs")
    .insert({
      owner_id: args.ownerId,
      campaign_id: args.campaignId,
      creative_id: args.creativeId,
      revision: args.revision,
      render_hash: hash,
      output_profile: DEFAULT_OUTPUT_PROFILE,
      design: args.snapshot,
      state: "queued",
    })
    .select("id, state, revision")
    .single();

  if (inserted.error) {
    // Another request inserted the identical design between our select and our
    // insert. That is the unique index doing its job, not a failure.
    const retry = await supabase
      .from("ad_video_jobs")
      .select("id, state, revision")
      .eq("render_hash", hash)
      .eq("output_profile", DEFAULT_OUTPUT_PROFILE)
      .maybeSingle();
    if (retry.data) {
      return {
        jobId: retry.data.id as string,
        state: retry.data.state as RenderState,
        revision: retry.data.revision as number,
        reused: true,
        enqueued: true,
      };
    }
    return { error: inserted.error.message };
  }

  const jobId = inserted.data.id as string;

  // Enqueue failures are not save failures. The row is the durable record; a
  // worker sweep can pick up a `queued` row whose BullMQ job never existed,
  // which is the whole reason the row is written first.
  let enqueued = false;
  try {
    enqueued = await enqueueRender({
      renderHash: hash,
      profile: DEFAULT_OUTPUT_PROFILE,
      data: {
        jobRowId: jobId,
        ownerId: args.ownerId,
        campaignId: args.campaignId,
        creativeId: args.creativeId,
        revision: args.revision,
        snapshot: args.snapshot,
        profile: DEFAULT_OUTPUT_PROFILE as VideoProfileId,
        audioSlotSupported: !!args.audioSlotSupported,
      },
    });
  } catch (err) {
    console.warn("[ads] video render enqueue failed", (err as Error).message);
  }

  return { jobId, state: "queued", revision: args.revision, reused: false, enqueued };
}

/**
 * Ensure the campaign has a video creative, and return the revision this edit
 * should render as.
 *
 * The revision is bumped on every call that follows a design change, which is
 * what makes the worker's compare-and-swap meaningful: two quick edits produce
 * revisions N and N+1, and whichever render finishes second only publishes if
 * its revision is still the requested one.
 *
 * published_revision is deliberately left alone. It is set by the worker once
 * ffprobe has validated the encode, and writing it here would mark a creative
 * servable before any bytes existed.
 */
export async function ensureVideoCreative(
  supabase: SupabaseClient,
  args: { campaignId: string; ownerId: string; bumpRevision: boolean },
): Promise<{ creativeId: string; revision: number } | { error: string }> {
  const existing = await supabase
    .from("ad_creatives")
    .select("id, requested_revision")
    .eq("campaign_id", args.campaignId)
    .eq("format", VIDEO_FORMAT_ID)
    .maybeSingle();

  if (existing.data) {
    const current = (existing.data.requested_revision as number | null) ?? 1;
    const revision = args.bumpRevision ? current + 1 : current;
    if (revision !== current) {
      const { error } = await supabase
        .from("ad_creatives")
        .update({ requested_revision: revision })
        .eq("id", existing.data.id)
        .eq("owner_id", args.ownerId);
      if (error) return { error: error.message };
    }
    return { creativeId: existing.data.id as string, revision };
  }

  // A fresh video creative carries no copy of its own: the design lives in the
  // snapshot, and the row exists to hold the revision pointers and to give
  // reporting something stable to attribute against. status stays 'generating'
  // so nothing treats it as ready, and published_revision stays null so
  // selection cannot pick it.
  const inserted = await supabase
    .from("ad_creatives")
    .insert({
      campaign_id: args.campaignId,
      owner_id: args.ownerId,
      format: VIDEO_FORMAT_ID,
      requested_revision: 1,
      status: "generating",
    })
    .select("id")
    .single();

  if (inserted.error) return { error: inserted.error.message };
  return { creativeId: inserted.data.id as string, revision: 1 };
}

/**
 * The whole flow for a campaign: creative row, revision, render job.
 *
 * Returns null rather than throwing on any failure. Every caller is a path an
 * advertiser is already waiting on — saving a campaign, editing copy — and none
 * of them should fail because a video could not be queued.
 */
export async function queueCampaignVideo(
  supabase: SupabaseClient,
  args: {
    campaignId: string;
    ownerId: string;
    domain: string;
    /**
     * The campaign's destination, used to decide whether it gets media at all.
     * Optional only so a caller without it degrades to rendering rather than to
     * silently skipping.
     */
    destinationUrl?: string | null;
    creatives: Parameters<typeof snapshotFromCreatives>[0]["creatives"];
    bumpRevision: boolean;
  },
): Promise<RenderHandle | null> {
  try {
    // Product ads only. The backfill classified campaigns before queueing them,
    // but every other path — the dashboard save, and the shared creator behind
    // the public API — queued a render for anything, so campaigns pointing at
    // blog posts and social profiles were getting video and animated banners
    // that were explicitly out of scope.
    //
    // Deciding it here rather than in each caller is the same lesson the API
    // gap taught: a rule enforced at one of three call sites is a rule that
    // holds until someone adds a fourth.
    if (args.destinationUrl && classifyCampaign(args.destinationUrl) !== "product") {
      return null;
    }

    const snapshot = snapshotFromCreatives({ creatives: args.creatives, domain: args.domain });
    if (!snapshot) return null;

    const creative = await ensureVideoCreative(supabase, {
      campaignId: args.campaignId,
      ownerId: args.ownerId,
      bumpRevision: args.bumpRevision,
    });
    if ("error" in creative) {
      console.warn("[ads] video creative failed", creative.error);
      return null;
    }

    const handle = await ensureRenderJob(supabase, {
      ownerId: args.ownerId,
      campaignId: args.campaignId,
      creativeId: creative.creativeId,
      snapshot,
      revision: creative.revision,
    });
    if ("error" in handle) {
      console.warn("[ads] video render job failed", handle.error);
      return null;
    }
    return handle;
  } catch (err) {
    console.warn("[ads] video render skipped", (err as Error).message);
    return null;
  }
}

/**
 * The most recent render job for a campaign.
 *
 * Newest first by revision then creation: an edit bumps the revision, so the
 * highest revision is the design the advertiser last asked for, and that is the
 * one whose progress they are watching. An older revision's job may still be
 * running and will publish nothing when it finishes (the worker's
 * compare-and-swap discards it), so showing it would be showing progress
 * towards an outcome that is already void.
 */
export async function latestJobForCampaign(
  supabase: SupabaseClient,
  args: { campaignId: string; ownerId: string },
): Promise<string | null> {
  const { data } = await supabase
    .from("ad_video_jobs")
    .select("id, revision, created_at")
    .eq("campaign_id", args.campaignId)
    .eq("owner_id", args.ownerId)
    .order("revision", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

export type RenderStatus = {
  jobId: string;
  state: RenderState;
  revision: number;
  errorCode: string | null;
  campaignId: string | null;
  assets: {
    profile: VideoProfileId;
    url: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
  }[];
};

/**
 * Read a render's state and its assets, scoped to the owner.
 *
 * Owner-scoped on the query rather than trusting RLS alone: this is read by a
 * server action and an API route, and a job id is a uuid somebody could hold
 * from a previous session after losing access to the campaign.
 */
export async function getRenderStatus(
  supabase: SupabaseClient,
  args: { jobId: string; ownerId: string; publicUrlFor: (objectKey: string) => string },
): Promise<RenderStatus | null> {
  const job = await supabase
    .from("ad_video_jobs")
    .select("id, state, revision, error_code, campaign_id, creative_id")
    .eq("id", args.jobId)
    .eq("owner_id", args.ownerId)
    .maybeSingle();

  if (!job.data) return null;

  const status: RenderStatus = {
    jobId: job.data.id as string,
    state: job.data.state as RenderState,
    revision: job.data.revision as number,
    errorCode: (job.data.error_code as string | null) ?? null,
    campaignId: (job.data.campaign_id as string | null) ?? null,
    assets: [],
  };

  // Only a ready job has assets worth listing. Asking for them earlier would
  // return a partial set mid-upload and invite a UI that plays half a render.
  if (status.state !== "ready" || !job.data.creative_id) return status;

  const assets = await supabase
    .from("ad_video_assets")
    .select("profile, object_key, byte_size, width, height, duration_ms")
    .eq("creative_id", job.data.creative_id)
    .eq("revision", status.revision);

  status.assets = (assets.data ?? []).map((a: Record<string, unknown>) => ({
    profile: a.profile as VideoProfileId,
    url: args.publicUrlFor(a.object_key as string),
    byteSize: Number(a.byte_size),
    width: (a.width as number | null) ?? null,
    height: (a.height as number | null) ?? null,
    durationMs: (a.duration_ms as number | null) ?? null,
  }));

  return status;
}

/** Advertiser-facing label for a render state. */
export function renderStateLabel(state: RenderState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "rendering":
      return "Rendering";
    case "validating":
      return "Validating";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

/** The profile an advertiser downloads: the 1080p master. */
export const DOWNLOAD_PROFILE: VideoProfileId = "master_1080p";

/**
 * The animated banners of a ready revision, in the order the dashboard lists
 * them. Empty for a revision rendered before they existed, which is why the
 * card treats them as optional rather than missing.
 */
export function animatedBanners(status: RenderStatus) {
  return GIF_PROFILE_IDS.map((id) => status.assets.find((a) => a.profile === id)).filter(
    (a): a is NonNullable<typeof a> => !!a,
  );
}

export function downloadableAsset(status: RenderStatus) {
  return status.assets.find((a) => a.profile === DOWNLOAD_PROFILE) ?? null;
}

/** Profiles that must be present before a revision counts as streamable. */
export function streamingReady(status: RenderStatus): boolean {
  const required = VIDEO_PROFILES.filter((p) => p.required).map((p) => p.id);
  return required.every((id) => status.assets.some((a) => a.profile === id));
}
