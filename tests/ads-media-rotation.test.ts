import { describe, expect, it } from "vitest";
import {
  AD_MEDIA_KINDS,
  applyMediaMix,
  availableMediaKinds,
  chooseMediaKind,
  mediaKindsForFormat,
  pickMediaKind,
  rotatesMedia,
  NO_MEDIA,
  type AdMediaKind,
} from "@/lib/ads/media";
import { displayMediaFor, slotMediaMix } from "@/lib/ads/display-media";
import { renderCreativeHtml } from "@/lib/ads/creative";
import type { AdCreative } from "@/lib/ads/formats";

const ALL: AdMediaKind[] = ["static", "image", "gif", "video", "audio"];

const FULL = {
  gifUrl: "https://cdn.example/gif.gif",
  videoUrl: "https://cdn.example/v.mp4",
  posterUrl: "https://cdn.example/p.webp",
  audioUrl: "https://cdn.example/a.m4a",
};

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "banner_300x250",
    headline: "Headline",
    body: "Body copy",
    ctaText: "Learn more",
    bgColor: "#101418",
    fgColor: "#f2f5f9",
    accentColor: "#4fd1c5",
    fontFamily: "system-ui, sans-serif",
    logoUrl: null,
    imageUrl: null,
    ...over,
  };
}

describe("what each size can carry", () => {
  it("gives the rectangle all five and the strip only what fits", () => {
    expect(mediaKindsForFormat("banner_300x250")).toEqual(ALL);
    // 90px cannot hold a 16:9 stage above a readable CTA, and there is no room
    // for an audio control beside the copy.
    expect(mediaKindsForFormat("banner_728x90")).toEqual(["static", "image", "gif"]);
    // 50px is a line and a button.
    expect(mediaKindsForFormat("banner_320x50")).toEqual(["static", "gif"]);
  });

  it("leaves the text, terminal and feed units alone", () => {
    for (const f of ["text_link", "terminal_ascii", "feed_item"] as const) {
      expect(mediaKindsForFormat(f)).toEqual(["static"]);
      expect(rotatesMedia(f)).toBe(false);
    }
  });

  it("never offers a display presentation to the streaming format", () => {
    // A break is served as media by /api/ads/stream and never reaches this
    // renderer; offering it a medium here would be the leak fitAdFormat guards.
    expect(mediaKindsForFormat("video_preroll_5s")).toEqual(["static"]);
    expect(rotatesMedia("video_preroll_5s")).toBe(false);
  });
});

describe("candidates are what actually exists", () => {
  it("is static-only for a campaign with nothing rendered and no hero", () => {
    expect(
      availableMediaKinds({ format: "banner_300x250", hasImage: false, assets: NO_MEDIA }),
    ).toEqual(["static"]);
  });

  it("always keeps static, so rotation can never produce an empty unit", () => {
    for (const format of ["banner_300x250", "banner_728x90", "banner_320x50"] as const) {
      const kinds = availableMediaKinds({ format, hasImage: false, assets: NO_MEDIA });
      expect(kinds).toContain("static");
      expect(kinds.length).toBeGreaterThan(0);
    }
  });

  it("offers each medium only when its bytes are present", () => {
    const onlyGif = { ...NO_MEDIA, gifUrl: FULL.gifUrl };
    expect(availableMediaKinds({ format: "banner_300x250", hasImage: false, assets: onlyGif })).toEqual(
      ["static", "gif"],
    );
    const onlyAudio = { ...NO_MEDIA, audioUrl: FULL.audioUrl };
    expect(
      availableMediaKinds({ format: "banner_300x250", hasImage: false, assets: onlyAudio }),
    ).toEqual(["static", "audio"]);
  });

  it("intersects the assets with what the size can hold", () => {
    // Everything rendered, but a leaderboard still cannot take video or audio.
    expect(availableMediaKinds({ format: "banner_728x90", hasImage: true, assets: FULL })).toEqual([
      "static",
      "image",
      "gif",
    ]);
    // …and the mobile strip takes neither the hero nor the companion.
    expect(availableMediaKinds({ format: "banner_320x50", hasImage: true, assets: FULL })).toEqual([
      "static",
      "gif",
    ]);
  });
});

describe("a publisher's allow-list", () => {
  it("rotates over everything when nothing is stated", () => {
    expect(applyMediaMix(ALL, null)).toEqual(ALL);
    expect(applyMediaMix(ALL, [])).toEqual(ALL);
  });

  it("narrows to what the publisher allowed", () => {
    expect(applyMediaMix(ALL, ["static", "image"])).toEqual(["static", "image"]);
  });

  it("falls back to the full list rather than to an empty one", () => {
    // A slot that allows only video, on a fill with no video, must get a static
    // ad — not a hole in the publisher's page.
    expect(applyMediaMix(["static", "image"], ["video"])).toEqual(["static", "image"]);
  });
});

describe("the draw", () => {
  it("reaches every candidate and no more", () => {
    const seen = new Set<AdMediaKind>();
    for (let i = 0; i < 2000; i++) {
      seen.add(
        chooseMediaKind({ format: "banner_300x250", hasImage: true, assets: FULL, rnd: Math.random }),
      );
    }
    expect([...seen].sort()).toEqual([...ALL].sort());
  });

  it("is uniform enough to read five arms", () => {
    const counts = new Map<AdMediaKind, number>();
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const k = chooseMediaKind({ format: "banner_300x250", hasImage: true, assets: FULL });
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const kind of ALL) {
      const share = (counts.get(kind) ?? 0) / n;
      expect(share).toBeGreaterThan(0.17);
      expect(share).toBeLessThan(0.23);
    }
  });

  it("never indexes past the candidates, however the generator behaves", () => {
    // A generator returning exactly 1 used to hand back undefined, which would
    // have rendered a unit with no presentation at all.
    for (const r of [0, 0.999999, 1, 1.5, -0.2]) {
      expect(AD_MEDIA_KINDS).toContain(pickMediaKind(ALL, () => r));
    }
    expect(pickMediaKind([], () => 0.5)).toBe("static");
  });
});

/**
 * A Supabase stand-in for the nested select displayMediaFor makes. Records the
 * filters so the fake can prove the query asked for the right creative.
 */
function db(opts: {
  publishedRevision?: number | null;
  assets?: { profile: string; object_key: string; revision: number; published: boolean }[];
  throws?: boolean;
  error?: boolean;
  mediaMix?: unknown;
  onFilters?: (f: Record<string, unknown>) => void;
}) {
  return {
    from() {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return b;
        },
        maybeSingle: async () => {
          opts.onFilters?.(filters);
          if (opts.throws) throw new Error("network");
          if (opts.error) return { data: null, error: { message: "no such column" } };
          if ("mediaMix" in opts) return { data: { media_mix: opts.mediaMix }, error: null };
          return {
            data: {
              published_revision: opts.publishedRevision ?? null,
              ad_video_assets: opts.assets ?? [],
            },
            error: null,
          };
        },
      });
      return b;
    },
  } as never;
}

const publicUrlFor = (key: string) => `https://cdn.example/${key}`;

describe("resolving a campaign's rendered media", () => {
  it("looks the assets up by the campaign, not by the banner creative", async () => {
    // The revision check confines published_revision to video_preroll_5s, so a
    // display fill's own creative has no assets. Querying by it is the bug that
    // left the animated banners rendered and unserved.
    let seen: Record<string, unknown> = {};
    await displayMediaFor(db({ publishedRevision: 2, onFilters: (f) => (seen = f) }), {
      campaignId: "camp-1",
      format: "banner_300x250",
      publicUrlFor,
    });
    expect(seen.campaign_id).toBe("camp-1");
    expect(seen.format).toBe("video_preroll_5s");
  });

  it("picks the animated banner that matches the size exactly", async () => {
    const assets = [
      { profile: "gif_300x250", object_key: "r/rect.gif", revision: 3, published: true },
      { profile: "gif_728x90", object_key: "r/lead.gif", revision: 3, published: true },
      { profile: "mp4_480p", object_key: "r/v.mp4", revision: 3, published: true },
      { profile: "poster", object_key: "r/p.webp", revision: 3, published: true },
      { profile: "audio", object_key: "r/a.m4a", revision: 3, published: true },
    ];
    const rect = await displayMediaFor(db({ publishedRevision: 3, assets }), {
      campaignId: "c",
      format: "banner_300x250",
      publicUrlFor,
    });
    expect(rect.gifUrl).toBe("https://cdn.example/r/rect.gif");
    expect(rect.videoUrl).toBe("https://cdn.example/r/v.mp4");
    expect(rect.posterUrl).toBe("https://cdn.example/r/p.webp");
    expect(rect.audioUrl).toBe("https://cdn.example/r/a.m4a");

    const lead = await displayMediaFor(db({ publishedRevision: 3, assets }), {
      campaignId: "c",
      format: "banner_728x90",
      publicUrlFor,
    });
    // Never the nearest one: a 300x250 GIF in a 728x90 box is two thirds empty.
    expect(lead.gifUrl).toBe("https://cdn.example/r/lead.gif");
  });

  it("serves nothing for a revision that has not published", async () => {
    const res = await displayMediaFor(
      db({
        publishedRevision: null,
        assets: [{ profile: "gif_300x250", object_key: "k", revision: 1, published: true }],
      }),
      { campaignId: "c", format: "banner_300x250", publicUrlFor },
    );
    expect(res).toEqual(NO_MEDIA);
  });

  it("ignores assets from another revision or not yet published", async () => {
    const res = await displayMediaFor(
      db({
        publishedRevision: 2,
        assets: [
          // Belongs to the revision still being written.
          { profile: "gif_300x250", object_key: "old.gif", revision: 1, published: true },
          // Validated but not published.
          { profile: "mp4_480p", object_key: "draft.mp4", revision: 2, published: false },
        ],
      }),
      { campaignId: "c", format: "banner_300x250", publicUrlFor },
    );
    expect(res).toEqual(NO_MEDIA);
  });

  it("spends no query on a format with nothing to rotate", async () => {
    let asked = false;
    const res = await displayMediaFor(db({ onFilters: () => (asked = true) }), {
      campaignId: "c",
      format: "text_link",
      publicUrlFor,
    });
    expect(asked).toBe(false);
    expect(res).toEqual(NO_MEDIA);
  });

  it("degrades to no media when the lookup fails, rather than failing the fill", async () => {
    for (const broken of [{ throws: true }, { error: true }]) {
      const res = await displayMediaFor(db(broken), {
        campaignId: "c",
        format: "banner_300x250",
        publicUrlFor,
      });
      expect(res).toEqual(NO_MEDIA);
    }
  });
});

describe("reading a slot's preference", () => {
  it("returns null when the column is absent, empty or not an array", async () => {
    for (const mix of [undefined, null, [], "gif", 7]) {
      expect(await slotMediaMix(db({ mediaMix: mix }), "slot")).toBeNull();
    }
  });

  it("returns the stated mix", async () => {
    expect(await slotMediaMix(db({ mediaMix: ["static", "image"] }), "slot")).toEqual([
      "static",
      "image",
    ]);
  });

  it("reads a failure as 'no preference' rather than throwing into serving", async () => {
    expect(await slotMediaMix(db({ throws: true }), "slot")).toBeNull();
    expect(await slotMediaMix(db({ error: true }), "slot")).toBeNull();
  });
});

describe("rendering each presentation", () => {
  const click = "https://crawlproof.com/api/ads/click?i=1";

  it("renders the animated banner as the whole unit, with no duplicated copy", () => {
    const html = renderCreativeHtml(creative(), click, { media: "gif", mediaAssets: FULL });
    expect(html).toContain(FULL.gifUrl);
    expect(html).toContain('width="300" height="250"');
    // The GIF already carries the headline and the CTA in its frames; drawing
    // them again would print every line twice.
    expect(html).not.toContain("Learn more");
    expect(html).toContain(`href="${click}"`);
  });

  it("gives in-banner video a 16:9 stage, a poster and a markup CTA", () => {
    const html = renderCreativeHtml(creative(), click, { media: "video", mediaAssets: FULL });
    expect(html).toContain("<video");
    expect(html).toContain(FULL.videoUrl);
    // 300 wide at 16:9.
    expect(html).toContain("height:169px");
    // The only combination a browser will start without a gesture.
    expect(html).toMatch(/autoplay muted loop playsinline/);
    expect(html).toContain(`poster="${FULL.posterUrl}"`);
    // The CTA is markup, so a publisher whose CSP blocks media but not images
    // still gets a still ad that reads correctly.
    expect(html).toContain("Learn more");
  });

  it("never renders video into a box with no room for a stage", () => {
    for (const format of ["banner_728x90", "banner_320x50"] as const) {
      const html = renderCreativeHtml(creative({ format }), click, {
        media: "video",
        mediaAssets: FULL,
      });
      expect(html).not.toContain("<video");
      // Falls through to the ordinary unit rather than rendering nothing.
      expect(html).toContain("Learn more");
    }
  });

  it("puts the audio companion on a native control outside the click link", () => {
    const html = renderCreativeHtml(creative(), click, { media: "audio", mediaAssets: FULL });
    expect(html).toContain("<audio");
    expect(html).toContain(FULL.audioUrl);
    // Click-to-play, never autoplay: a page that starts talking gets the tag pulled.
    expect(html).toContain("controls");
    expect(html).not.toMatch(/<audio[^>]*\bautoplay\b/);
    // A control inside an <a> cannot be operated — the first click navigates.
    const audioAt = html.indexOf("<audio");
    const linkClose = html.indexOf("</a>");
    expect(audioAt).toBeGreaterThan(linkClose);
  });

  it("actually suppresses the hero on the static arm", () => {
    const withHero = creative({ imageUrl: "https://cdn.example/hero.png" });
    // Otherwise 'static' is the image arm with a different label and the
    // measurement means nothing.
    expect(renderCreativeHtml(withHero, click, { media: "static" })).not.toContain("hero.png");
    expect(renderCreativeHtml(withHero, click, { media: "image" })).toContain("hero.png");
  });

  it("shows the leaderboard's hero as a plate so image differs from static", () => {
    const lead = creative({ format: "banner_728x90", imageUrl: "https://cdn.example/hero.png" });
    const asImage = renderCreativeHtml(lead, click, { media: "image" });
    const asStatic = renderCreativeHtml(lead, click, { media: "static" });
    expect(asImage).toContain("hero.png");
    expect(asStatic).not.toContain("hero.png");
    expect(asImage).not.toEqual(asStatic);
  });

  it("is unchanged for a caller that names no medium", () => {
    // The React preview and every test predating rotation pass no media, and
    // must keep getting the creative-driven behaviour.
    const withHero = creative({ imageUrl: "https://cdn.example/hero.png" });
    expect(renderCreativeHtml(withHero, click)).toEqual(
      renderCreativeHtml(withHero, click, { media: "image" }),
    );
    expect(renderCreativeHtml(creative(), click)).toEqual(
      renderCreativeHtml(creative(), click, { media: "static" }),
    );
  });

  it("falls back to the drawn unit when the asset a medium needs is missing", () => {
    for (const media of ["gif", "video", "audio"] as const) {
      const html = renderCreativeHtml(creative(), click, { media, mediaAssets: NO_MEDIA });
      expect(html).toContain("Learn more");
      expect(html).not.toContain("<video");
      expect(html).not.toContain("<audio");
    }
  });
});
