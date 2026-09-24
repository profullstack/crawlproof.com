import { describe, expect, it } from "vitest";
import { streamMediaFor, animatedBannerFor } from "@/lib/ads/video/serve";

/**
 * A Supabase stand-in narrow enough to be read at a glance: it answers the two
 * queries this module makes and records nothing else.
 */
function db(opts: {
  publishedRevision: number | null;
  assets?: { profile: string; object_key: string; duration_ms?: number | null; published?: boolean }[];
}) {
  const assets = opts.assets ?? [];
  return {
    from(table: string) {
      if (table === "ad_creatives") {
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { published_revision: opts.publishedRevision },
          }),
        });
        return b;
      }
      // ad_video_assets: collect the eq() filters so the fake honours them.
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return b;
        },
        maybeSingle: async () => {
          const hit = assets.find(
            (a) =>
              a.profile === filters.profile &&
              (a.published ?? true) === (filters.published ?? true),
          );
          return { data: hit ?? null };
        },
        then: undefined,
      });
      // The list query is awaited directly, so the builder resolves as a promise.
      (b as { then?: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({
          data: assets.filter((a) => (a.published ?? true) === (filters.published ?? true)),
        });
      return b;
    },
  };
}

const publicUrlFor = (key: string) => `https://cdn.example/${key}`;

describe("only a published revision is servable", () => {
  it("returns nothing when the creative has never published one", async () => {
    // published_revision is set by the worker after validation. Serving the
    // newest revision instead would put media on air that was never approved.
    const res = await streamMediaFor(db({ publishedRevision: null }) as never, {
      creativeId: "c",
      kind: "audio",
      publicUrlFor,
    });
    expect(res).toBeNull();
  });

  it("returns nothing when the published revision has no media of that kind", async () => {
    const res = await streamMediaFor(
      db({ publishedRevision: 2, assets: [{ profile: "poster", object_key: "p.webp" }] }) as never,
      { creativeId: "c", kind: "audio", publicUrlFor },
    );
    // A break that cannot be filled correctly should not happen at all.
    expect(res).toBeNull();
  });
});

describe("the right file for the right player", () => {
  const assets = [
    { profile: "audio", object_key: "r2/audio.m4a", duration_ms: 5000 },
    { profile: "mp4_720p", object_key: "r2/720.mp4", duration_ms: 5000 },
    { profile: "master_1080p", object_key: "r2/master.mp4", duration_ms: 5000 },
    { profile: "poster", object_key: "r2/poster.webp" },
    { profile: "captions", object_key: "r2/cc.vtt" },
  ];

  it("gives a music player the audio companion and no poster", async () => {
    const res = await streamMediaFor(db({ publishedRevision: 2, assets }) as never, {
      creativeId: "c",
      kind: "audio",
      publicUrlFor,
    });
    expect(res!.url).toBe("https://cdn.example/r2/audio.m4a");
    // There is nowhere to show a poster during an audio break.
    expect(res!.posterUrl).toBeNull();
    expect(res!.captionsUrl).toBe("https://cdn.example/r2/cc.vtt");
    expect(res!.revision).toBe(2);
  });

  it("gives a video player 720p, not the master", async () => {
    // The master is the advertiser's download. Making a phone fetch it to watch
    // five seconds spends their data on pixels the screen cannot show.
    const res = await streamMediaFor(db({ publishedRevision: 2, assets }) as never, {
      creativeId: "c",
      kind: "video",
      publicUrlFor,
    });
    expect(res!.url).toBe("https://cdn.example/r2/720.mp4");
    expect(res!.posterUrl).toBe("https://cdn.example/r2/poster.webp");
  });
});

describe("animated banners are addressed by size", () => {
  it("returns the requested unit from the published revision", async () => {
    const res = await animatedBannerFor(
      db({
        publishedRevision: 3,
        assets: [{ profile: "gif_728x90", object_key: "r3/gif_728x90.gif" }],
      }) as never,
      { creativeId: "c", profile: "gif_728x90", publicUrlFor },
    );
    expect(res).toEqual({ url: "https://cdn.example/r3/gif_728x90.gif", revision: 3 });
  });

  it("returns nothing for a size this revision does not have", async () => {
    const res = await animatedBannerFor(
      db({ publishedRevision: 3, assets: [{ profile: "gif_728x90", object_key: "x" }] }) as never,
      { creativeId: "c", profile: "gif_300x250", publicUrlFor },
    );
    expect(res).toBeNull();
  });
});
