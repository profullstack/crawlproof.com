import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_PROFILE,
  downloadableAsset,
  ensureRenderJob,
  ensureVideoCreative,
  MAX_RENDER_ATTEMPTS,
  renderStateLabel,
  queueCampaignVideo,
  snapshotFromCreatives,
  streamingReady,
  trimHeadlineForVideo,
  type RenderStatus,
} from "@/lib/ads/video/jobs";
import { MAX_HEADLINE_WORDS, renderHash, validateSnapshot } from "@/lib/ads/video/snapshot";
import { VIDEO_FORMAT_ID } from "@/lib/ads/formats";

const design = (format: string, over: Record<string, unknown> = {}) => ({
  format,
  headline: "Sources in, feeds out",
  ctaText: "Start free",
  bgColor: "#12161f",
  fgColor: "#e7e9ee",
  accentColor: "#6ee7b7",
  fontFamily: "system-ui, sans-serif",
  logoUrl: null,
  imageUrl: null,
  ...over,
}) as Parameters<typeof snapshotFromCreatives>[0]["creatives"][number];

describe("the snapshot is derived from approved copy", () => {
  it("prefers the rectangle, which carries the full headline", () => {
    const snap = snapshotFromCreatives({
      creatives: [
        design("banner_320x50", { headline: "Short one" }),
        design("banner_300x250", { headline: "Sources in, feeds out" }),
      ],
      domain: "nichedb.dev",
    });
    // banner_320x50 holds the *shortened* mobile headline, and a 1920x1080
    // frame has no width problem that would justify truncated copy.
    expect(snap?.headline).toBe("Sources in, feeds out");
  });

  it("falls back down the preference list rather than giving up", () => {
    const snap = snapshotFromCreatives({
      creatives: [design("feed_item", { headline: "Only a feed item" })],
      domain: "nichedb.dev",
    });
    expect(snap?.headline).toBe("Only a feed item");
  });

  it("returns null when there is no design to derive from", () => {
    expect(snapshotFromCreatives({ creatives: [], domain: "nichedb.dev" })).toBeNull();
  });

  it("produces a snapshot that passes validation", () => {
    const snap = snapshotFromCreatives({
      creatives: [design("banner_300x250")],
      domain: "nichedb.dev",
    })!;
    expect(validateSnapshot(snap)).toEqual([]);
    // Silent by default, so nothing claims an audible companion it has not got.
    expect(snap.audioMode).toBe("silent");
    expect(snap.narration).toBeNull();
  });

  it("records no artwork URL while it records no content hash", () => {
    const snap = snapshotFromCreatives({
      creatives: [design("banner_300x250", { imageUrl: "https://cdn/hero.png" })],
      domain: "nichedb.dev",
    })!;
    // The dedupe key trusts the hash. A URL with a null hash would invite a
    // later change to treat the URL as sufficient, and the same URL can serve
    // different bytes.
    expect(snap.heroUrl).toBeNull();
    expect(snap.heroSha256).toBeNull();
  });
});

describe("headlines are clipped to what five seconds can hold", () => {
  it("leaves a short headline exactly as it is", () => {
    expect(trimHeadlineForVideo("Sources in, feeds out")).toBe("Sources in, feeds out");
  });

  it("clips on a word boundary, never mid-word", () => {
    const long = "one two three four five six seven eight nine ten";
    const out = trimHeadlineForVideo(long);
    expect(out.split(" ")).toHaveLength(MAX_HEADLINE_WORDS);
    expect(out).toBe("one two three four five six seven eight");
    expect(long.startsWith(out)).toBe(true);
  });

  it("produces a headline the snapshot validator accepts", () => {
    const snap = snapshotFromCreatives({
      creatives: [design("banner_300x250", { headline: "a b c d e f g h i j k" })],
      domain: "nichedb.dev",
    })!;
    // The clip has to actually satisfy the rule, or every long-headline
    // campaign would queue a job that the renderer then refuses.
    expect(validateSnapshot(snap)).toEqual([]);
  });
});

// A very small Supabase stand-in: enough query-builder surface for the calls
// jobs.ts makes, and it records what was written.
function fakeDb(opts: {
  existingJob?: Record<string, unknown> | null;
  existingCreative?: Record<string, unknown> | null;
  insertError?: string;
}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const updates: { table: string; patch: Record<string, unknown> }[] = [];

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        order: chain,
        limit: chain,
        maybeSingle: async () => ({
          data:
            table === "ad_video_jobs"
              ? (opts.existingJob ?? null)
              : (opts.existingCreative ?? null),
error: null,
        }),
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return {
            select: () => ({
              single: async () =>
                opts.insertError
                  ? { data: null, error: { message: opts.insertError } }
                  : { data: { id: "new-id", state: "queued", revision: row.revision ?? 1 }, error: null },
            }),
          };
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          const u: Record<string, unknown> = {};
          Object.assign(u, { eq: () => u, select: async () => ({ data: [{ id: "x" }] }) });
          return u;
        },
      });
      return builder;
    },
  };
  return { client, inserts, updates };
}

describe("render jobs dedupe on the design, not the campaign", () => {
  const snapshot = snapshotFromCreatives({
    creatives: [design("banner_300x250")],
    domain: "nichedb.dev",
  })!;

  it("hands back an existing job for an identical design", async () => {
    const db = fakeDb({ existingJob: { id: "job-1", state: "rendering", revision: 2 } });
    const res = await ensureRenderJob(db.client as never, {
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      snapshot,
      revision: 2,
    });
    expect(res).toMatchObject({ jobId: "job-1", state: "rendering", reused: true });
    // Nothing queued: the same design previewed, saved and regenerated without
    // edits is one encode.
    expect(db.inserts).toHaveLength(0);
  });

  it("retries a failed job instead of handing the failure back forever", async () => {
    // Dedupe is keyed by the design, so returning the failed row made a failure
    // permanent for that copy: re-saving hit the same hash, and the card's
    // advice to edit and retry could not work.
    const db = fakeDb({ existingJob: { id: "job-f", state: "failed", revision: 1, attempts: 1 } });
    const res = await ensureRenderJob(db.client as never, {
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      snapshot,
      revision: 1,
    });
    expect(res).toMatchObject({ jobId: "job-f", state: "queued", reused: true });
    expect(db.updates[0].patch).toMatchObject({ state: "queued", error_code: null });
  });

  it("stops retrying once the cap is reached", async () => {
    // The failure may be deterministic, and the row is keyed by design rather
    // than by attempt, so an uncapped retry re-runs doomed work on every save.
    const db = fakeDb({
      existingJob: { id: "job-f", state: "failed", revision: 1, attempts: MAX_RENDER_ATTEMPTS },
    });
    const res = await ensureRenderJob(db.client as never, {
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      snapshot,
      revision: 1,
    });
    expect(res).toMatchObject({ state: "failed", reused: true });
    expect(db.updates).toHaveLength(0);
  });

  it("writes the row before trying to enqueue", async () => {
    const db = fakeDb({ existingJob: null });
    const res = await ensureRenderJob(db.client as never, {
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      snapshot,
      revision: 1,
    });
    expect("jobId" in res && res.jobId).toBe("new-id");
    const row = db.inserts[0].row;
    expect(db.inserts[0].table).toBe("ad_video_jobs");
    expect(row.state).toBe("queued");
    expect(row.output_profile).toBe(DEFAULT_OUTPUT_PROFILE);
    expect(row.render_hash).toBe(renderHash(snapshot, DEFAULT_OUTPUT_PROFILE as never));
  });

  it("survives Redis being unavailable", async () => {
    // No REDIS_URL in the test env, so enqueueRender returns false. The row
    // still exists and a sweep can pick it up — which is the whole reason the
    // row is written first.
    const db = fakeDb({ existingJob: null });
    const res = await ensureRenderJob(db.client as never, {
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      snapshot,
      revision: 1,
    });
    expect("enqueued" in res && res.enqueued).toBe(false);
    expect("state" in res && res.state).toBe("queued");
  });

  it("refuses a snapshot that cannot render", async () => {
    const db = fakeDb({ existingJob: null });
    const res = await ensureRenderJob(db.client as never, {
      ownerId: "o",
      campaignId: "c",
      creativeId: "cr",
      snapshot: { ...snapshot, headline: "" },
      revision: 1,
    });
    expect("error" in res).toBe(true);
    expect(db.inserts).toHaveLength(0);
  });
});

describe("the video creative row", () => {
  it("starts unservable: generating, and no published revision", async () => {
    const db = fakeDb({ existingCreative: null });
    const res = await ensureVideoCreative(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      bumpRevision: false,
    });
    expect("creativeId" in res).toBe(true);
    const row = db.inserts[0].row;
    expect(row.format).toBe(VIDEO_FORMAT_ID);
    expect(row.requested_revision).toBe(1);
    expect(row.status).toBe("generating");
    // published_revision is the worker's to set, once ffprobe has validated an
    // encode. Setting it here would mark a creative servable with no bytes.
    expect(row.published_revision).toBeUndefined();
  });

  it("bumps the revision on an edit so the worker's CAS means something", async () => {
    const db = fakeDb({ existingCreative: { id: "cr-1", requested_revision: 4 } });
    const res = await ensureVideoCreative(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      bumpRevision: true,
    });
    expect(res).toMatchObject({ creativeId: "cr-1", revision: 5 });
    expect(db.updates[0].patch).toEqual({ requested_revision: 5 });
  });

  it("does not bump on a plain save", async () => {
    const db = fakeDb({ existingCreative: { id: "cr-1", requested_revision: 4 } });
    const res = await ensureVideoCreative(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      bumpRevision: false,
    });
    expect(res).toMatchObject({ revision: 4 });
    expect(db.updates).toHaveLength(0);
  });
});

describe("status presentation", () => {
  const status = (assets: string[]): RenderStatus => ({
    jobId: "j",
    state: "ready",
    revision: 1,
    errorCode: null,
    campaignId: "c",
    assets: assets.map((profile) => ({
      profile: profile as never,
      url: `https://cdn/${profile}`,
      byteSize: 1000,
      width: null,
      height: null,
      durationMs: null,
    })),
  });

  it("offers the 1080p master as the download", () => {
    expect(downloadableAsset(status(["master_1080p", "mp4_720p"]))?.url).toBe(
      "https://cdn/master_1080p",
    );
    expect(downloadableAsset(status(["mp4_720p"]))).toBeNull();
  });

  it("only calls a revision streamable when every required profile is present", () => {
    // Downloadable and streamable are different permissions: an advertiser may
    // download a draft long before anything may serve it.
    expect(streamingReady(status(["master_1080p"]))).toBe(false);
    expect(
      streamingReady(status(["master_1080p", "mp4_720p", "mp4_480p", "hls", "poster"])),
    ).toBe(true);
  });

  it("labels every state", () => {
    for (const s of ["queued", "rendering", "validating", "ready", "failed"] as const) {
      expect(renderStateLabel(s)).toMatch(/\w/);
    }
  });
});

describe("only product campaigns get media", () => {
  const creatives = [design("banner_300x250")];

  it("skips a campaign that points at a blog post", async () => {
    // The backfill classified before queueing, but the dashboard save and the
    // public API queued anything — so blog campaigns were getting video and
    // animated banners that were explicitly out of scope. The rule belongs
    // where all three paths pass through.
    const db = fakeDb({ existingJob: null, existingCreative: null });
    const res = await queueCampaignVideo(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      domain: "dev.to",
      destinationUrl: "https://dev.to/chovy/some-post-abc",
      creatives,
      bumpRevision: false,
    });
    expect(res).toBeNull();
    // Nothing written at all: no creative row, no job.
    expect(db.inserts).toHaveLength(0);
  });

  it("skips a social profile", async () => {
    const db = fakeDb({ existingJob: null, existingCreative: null });
    const res = await queueCampaignVideo(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      domain: "x.com",
      destinationUrl: "https://x.com/someone",
      creatives,
      bumpRevision: false,
    });
    expect(res).toBeNull();
    expect(db.inserts).toHaveLength(0);
  });

  it("renders a product campaign", async () => {
    const db = fakeDb({ existingJob: null, existingCreative: null });
    const res = await queueCampaignVideo(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      domain: "moshcoding.com",
      destinationUrl: "https://moshcoding.com/",
      creatives,
      bumpRevision: false,
    });
    expect(res).not.toBeNull();
  });

  it("renders when no destination is known, rather than silently skipping", async () => {
    // Degrading to "render it" is the safer default: a caller that forgets to
    // pass the URL produces an extra video, not a campaign that mysteriously
    // never gets one.
    const db = fakeDb({ existingJob: null, existingCreative: null });
    const res = await queueCampaignVideo(db.client as never, {
      campaignId: "c",
      ownerId: "o",
      domain: "example.com",
      creatives,
      bumpRevision: false,
    });
    expect(res).not.toBeNull();
  });
});
