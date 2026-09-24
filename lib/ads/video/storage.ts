// Where a rendered revision's bytes live.
//
// Reuses the existing public `ad-assets` bucket rather than provisioning new
// storage: it is already how server-generated ad art (see ../heroImage) is
// hosted, its RLS already confines authenticated writes to a user's own prefix,
// and service-role uploads already bypass that for generated content.

import { serviceClient } from "@/lib/supabase/service";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VideoProfileId } from "./profiles";
import type { RenderedAsset } from "./render";

export const ASSET_BUCKET = "ad-assets";

/**
 * Immutable object prefix for one revision.
 *
 * Revision is in the path, so publishing a new one adds objects rather than
 * replacing them. That is what lets a decision already issued keep resolving to
 * the exact bytes the viewer was promised while a newer revision serves every
 * session that starts afterwards — and it is why these objects can be cached
 * immutably at the edge.
 */
export function revisionPrefix(args: {
  ownerId: string;
  campaignId: string;
  creativeId: string;
  revision: number;
}): string {
  return `video/${args.ownerId}/${args.campaignId}/${args.creativeId}/r${args.revision}`;
}

/** Object key for one profile's primary file. */
export function objectKey(
  prefix: string,
  profile: VideoProfileId,
  filename: string,
): string {
  // HLS is a directory of files, so it keeps its own subtree; every other
  // profile is a single object named for the profile.
  return profile === "hls" ? `${prefix}/hls/${filename}` : `${prefix}/${filename}`;
}

export type UploadedAsset = {
  profile: VideoProfileId;
  objectKey: string;
  publicUrl: string;
  byteSize: number;
  sha256: string;
  contentType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codecs: string | null;
};

/**
 * Upload one render's outputs.
 *
 * Draft renders are uploaded to the same bucket as published ones and are
 * distinguished by the `published` flag on ad_video_assets rather than by
 * location, so publishing a revision is a database transaction rather than a
 * byte copy. The flip side — draft bytes are reachable by URL to anyone who
 * guesses a uuid quadruple — is acceptable for ad creative and is the same
 * posture the hero images already have. Anything genuinely private would need a
 * separate private bucket and signed delivery.
 */
export async function uploadRenderedAssets(args: {
  assets: RenderedAsset[];
  ownerId: string;
  campaignId: string;
  creativeId: string;
  revision: number;
}): Promise<UploadedAsset[]> {
  const svc = serviceClient();
  const prefix = revisionPrefix(args);
  const uploaded: UploadedAsset[] = [];

  for (const asset of args.assets) {
    // HLS travels as a set: the playlist is useless without its init segment
    // and media segments, so they upload together or the profile does not
    // count as stored at all.
    const files = [asset.filePath, ...(asset.extraFiles ?? [])];
    let primaryKey = "";

    for (const filePath of files) {
      const bytes = await readFile(filePath);
      const key = objectKey(prefix, asset.profile, path.basename(filePath));
      const { error } = await svc.storage.from(ASSET_BUCKET).upload(key, bytes, {
        contentType: contentTypeFor(filePath, asset.contentType),
        upsert: false,
        // A revision's objects never change, so the edge may keep them for a
        // year. A new revision is a new path.
        cacheControl: "public, max-age=31536000, immutable",
      });
      if (error) {
        throw new Error(`upload failed for ${key}: ${error.message}`);
      }
      if (filePath === asset.filePath) primaryKey = key;
    }

    uploaded.push({
      profile: asset.profile,
      objectKey: primaryKey,
      publicUrl: svc.storage.from(ASSET_BUCKET).getPublicUrl(primaryKey).data.publicUrl,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      contentType: asset.contentType,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      codecs: asset.codecs,
    });
  }

  return uploaded;
}

/**
 * Per-file content type.
 *
 * The HLS profile's declared type describes its playlist; the segments and init
 * fragment beside it are MP4. Serving an .m4s as application/vnd.apple.mpegurl
 * makes some players refuse it outright.
 */
export function contentTypeFor(filePath: string, profileContentType: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".m3u8":
      return "application/vnd.apple.mpegurl";
    case ".m4s":
    case ".mp4":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".webp":
      return "image/webp";
    case ".vtt":
      return "text/vtt";
    default:
      return profileContentType;
  }
}
