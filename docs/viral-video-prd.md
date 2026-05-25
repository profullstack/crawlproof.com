# Crawlproof Viral Video — PRD

> Goal: a revid.ai-style short-form AI-video generator inside crawlproof.com. Customer picks a brand/niche/topic → we auto-script, voice, source b-roll, caption, render, and post to TikTok / Reels / Shorts / Bluesky video / LinkedIn video / Threads video. Daily/weekly cadence. Same credit ledger as autoblog + social posting.
>
> Depends on the **Social Posting** PRD shipping first (`docs/social-posting-prd.md`) — distribution is the social-posting layer.

---

## Status as of 2026-05-15

**Phase 0 — PRD: this document.**

**Phase 1 — Single-video pipeline + manual download: PLANNED.**
- Customer triggers a one-off video render. We produce a 30–60s MP4 (9:16 vertical), deliver to a Supabase Storage URL. Customer downloads + uploads themselves. No auto-distribution yet.
- Smallest shippable unit. Proves the rendering pipeline before we bolt distribution on.

**Phase 2 — Scheduled + auto-distribute: PLANNED.**
- Cron tick generates per the schedule (e.g. 1 video/day per site), pipes through the Social Posting layer for TikTok/Reels/Shorts/etc. publishing.
- Requires Social Posting Phase 1+2 live.

**Phase 3 — AI-generated b-roll (Sora / Runway / Veo): PLANNED, gated on cost.**
- Today's per-clip prices for AI video gen are $0.10–$1.00/sec generated. A 45s video that's pure AI b-roll is $4–$45 in raw cost. Not viable at 1 credit/video.
- Ships when prices drop or we offer a "Premium video" tier at higher credit cost.

---

## 1. Competitive landscape

**To recon before build** — log in, capture pipeline, document.

- **revid.ai** ([revid.ai/features](https://www.revid.ai/features)) — the explicit reference. Sells TikTok/Reels generation from a topic. Their pricing is per-credit, like ours.
- **OpusClip** — focuses on slicing long video into short clips. Adjacent, not directly competitive.
- **AutoShorts.ai** — closest to revid.ai, simpler UI.
- **Topview.ai** — TikTok-focused, includes auto-posting.
- **HeyGen / D-ID** — talking-head AI avatars. Different niche; our v1 is text-on-stock-footage style.

What we want from recon:
- Render time per video (revid.ai claims "~2 min"; reality often 5–10).
- Voice quality + voice library size (ElevenLabs vs OpenAI TTS vs custom).
- B-roll provenance (Pexels / Pixabay / their own AI-generated library).
- Caption styling — kinetic typography is the look that "feels TikTok native."
- How they handle music licensing (their library? user uploads? license-free?).

---

## 2. The Crawlproof version — scope

### 2.1 Positioning
- Sold as an add-on inside crawlproof.com.
- Cross-sells with autoblog (long-form) + social posting (distribution). The wedge: **one tool, three content forms**.
- One *site* → N videos per period. Same per-site config as autoblog (niche, audience, brand voice).

### 2.2 What we keep + what we drop vs. revid.ai

| | revid.ai | Crawlproof v1 |
|---|---|---|
| AI script → AI voice → b-roll → captions → render | ✓ | ✓ |
| Multiple voice options (TTS) | ✓ (10+ voices) | v1: 3 voices (OpenAI TTS). v2: ElevenLabs library. |
| Stock b-roll library | ✓ | ✓ via Pexels / Pixabay API |
| AI-generated b-roll (text-to-video) | ✓ | v3 only, gated on cost |
| Kinetic / animated captions | ✓ | ✓ via Remotion |
| Avatar-talking-head mode | ✓ | ✗ (skip; different niche) |
| Brand kit (logo, color, font) | ✓ | v2 |
| Auto-post to TikTok / Reels / Shorts | ✓ | ✓ via Social Posting (Phase 2) |
| Music library | ✓ licensed | v1: royalty-free (Free Music Archive, Pixabay Music). v2: licensed. |
| Per-platform aspect-ratio variants (9:16 / 1:1 / 16:9) | ✓ | v1: 9:16 only. v2: all. |

---

## 3. Pipeline (technical, end-to-end)

Each video is a 7-stage pipeline. Stages run inline in one worker job (`vid.render`) because the artifacts hand off in sequence:

```
1. Script  → Claude Sonnet 4.6 (operator-voice prompt narrowed to short-form)
2. Voice   → OpenAI TTS `tts-1-hd` (cheap) OR ElevenLabs (premium)
3. B-roll  → Pexels / Pixabay video search keyed off script keywords
4. Music   → curated royalty-free library, selected by niche tag
5. Captions→ generated from script + voice alignment (assemblyai OR forced-align)
6. Compose → Remotion (React-based video composition) → headless Chromium render
7. Render  → MP4 (H.264 + AAC, 9:16, 1080×1920, 30fps, ~30–60s)
```

Output → Supabase Storage public bucket `lx-video-renders` → public URL handed to the Social Posting layer for distribution.

### 3.1 Script generation

Claude Sonnet 4.6, prompt tuned for short-form vertical video:

- 30–60 second target = ~80–150 words spoken.
- Open with a hook in the first 3 seconds ("Most teams think X. Actually Y.").
- 2–4 substance beats.
- End with a soft CTA tied to the brand.
- No filler. No "today we're going to talk about." No "here's the thing." Direct, operator-voice.
- Output: `{ hook, beats[], cta, full_script }`.

Cost: ~$0.01/script with Sonnet 4.6, well under credit price.

### 3.2 Voice

**v1: OpenAI TTS** (`tts-1-hd`, voice = `onyx` / `nova` / `alloy`). $0.030 per 1k chars. A 60s script ~ 150 chars → $0.0045 per video.

**v2: ElevenLabs**. Better quality, voice cloning support. $0.30 per 1k chars at the Creator tier → $0.045 per video. 10× cost vs. OpenAI; bumps the credit cost or shifts to premium tier.

The voice file lands as an MP3, ~300 KB.

### 3.3 B-roll

**Pexels Video API** ([pexels.com/api](https://www.pexels.com/api/)) — free, attribution-required but Pexels says the attribution is optional for video. 200 requests/hour limit.

Pipeline:
1. Extract 3–5 noun phrases from the script (Claude does this in the same call).
2. For each phrase, query Pexels with `orientation=portrait` (matches 9:16).
3. Take the top result per phrase.
4. Download the 1080p MP4 of each clip.
5. Trim each to (script_duration / phrase_count) seconds.

Fallback: **Pixabay Video** if Pexels rate-limits us.

Storage: each video pulls ~5 clips × 10 MB = 50 MB of b-roll. We don't persist these; they live in `/tmp` during render, get cleaned up after.

### 3.4 Music

v1: a curated `lib/vid/music/*.mp3` library checked into the repo (10–20 tracks, royalty-free, niche-tagged). Volume ducked to -20 dB under the voice.

v2: licensed music API (Epidemic Sound has an API but it's expensive; Artlist similar). Defer.

### 3.5 Captions

**Forced alignment** between the script text and the TTS audio:
- v1: trust the TTS service's word-timestamps if available (OpenAI doesn't return them yet).
- v1 fallback: estimate word timing as `(audio_duration / word_count) * word_index` — works for TTS because pacing is uniform.
- v2: use `AssemblyAI` or `whisper` for real word-level timestamps (~$0.01/min audio).

Caption styling:
- Burn-in (rendered into the video, not VTT) — TikTok / Reels expect this.
- 3–5 words per "card", kinetic / pop-in animation.
- High contrast (white text + black drop shadow + optional yellow highlight on the keyword).
- Font: Inter Black or similar. Bundled with the repo.

### 3.6 Composition + render

**Remotion** ([remotion.dev](https://www.remotion.dev/)) — React-based video framework. Compose the timeline as a React component, render to MP4 via headless Chromium.

Why Remotion vs. raw FFmpeg:
- Easier kinetic-typography animation (CSS + React-Spring).
- Composability: brand kit, intro/outro, watermark all live as components.
- Render quality is identical (Remotion shells out to FFmpeg under the hood).

Why not raw FFmpeg:
- Caption animation is painful to hand-write as FFmpeg filter chains.
- Iterating on look-and-feel requires code redeploys.

Compute: Remotion rendering on a 4-core box, 60s video ≈ 90s render time. Bigger box = linear speedup. Workers run on Railway with a dedicated `viral-video-worker` service.

### 3.7 Storage + handoff

Final MP4 → Supabase Storage bucket `lx-video-renders` (public). URL → `vid_job.public_url` → handed to the Social Posting layer when distribution is enabled.

Retention: 30 days, then auto-delete (storage cleanup cron).

---

## 4. Data model (Supabase)

```sql
-- A single video generation job.
create table vid_job (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  site_id uuid references lx_site(id) on delete set null,  -- ties to autoblog site config
  -- What the user asked for.
  topic text not null,
  niche text,
  target_audience text,
  duration_seconds smallint not null default 45 check (duration_seconds between 15 and 90),
  voice text not null default 'nova',
  aspect_ratio text not null default '9:16'
    check (aspect_ratio in ('9:16','1:1','16:9')),
  -- Generated artifacts.
  script_text text,
  voice_audio_url text,
  caption_segments jsonb,
  broll_clip_urls text[] not null default '{}',
  music_track text,
  public_url text,           -- the final MP4
  thumbnail_url text,        -- first-frame JPEG for previews
  -- Distribution.
  auto_distribute boolean not null default false,
  distributed_to_post_ids uuid[] not null default '{}',  -- sp_post rows
  -- Lifecycle.
  status text not null default 'queued'
    check (status in ('queued','scripting','voicing','sourcing','rendering','ready','failed','distributed')),
  render_started_at timestamptz,
  render_completed_at timestamptz,
  fail_stage text,
  fail_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on vid_job(user_id, status, created_at desc);

-- Cost ledger for finance — every Pexels call, every OpenAI TTS call, every render minute.
create table vid_cost_ledger (
  id bigserial primary key,
  job_id uuid not null references vid_job(id) on delete cascade,
  stage text not null check (stage in ('script','voice','broll','captions','render','storage')),
  cost_usd numeric(10,4) not null,
  created_at timestamptz not null default now()
);
create index on vid_cost_ledger(job_id);
```

---

## 5. COGS realism + the pricing problem

Per-video direct costs:

| Stage | Cost |
|---|---|
| Script (Claude Sonnet 4.6, ~2k input + 200 output tokens) | $0.010 |
| Voice (OpenAI TTS, 150 chars) | $0.005 |
| B-roll (Pexels — free) | $0 |
| Music (royalty-free library — free) | $0 |
| Captions (script-alignment in v1, free) | $0 |
| Render compute (90s on a 4-core Railway box at $0.05/hour) | $0.001 |
| Storage (30 days × 30 MB at Supabase pricing) | $0.001 |
| Bandwidth on download (one TikTok post = ~30 MB out) | $0.001 |
| **Total v1** | **~$0.018** |

**v1 at OpenAI TTS is profitable at 1 credit/video.** Credit price $0.20–0.30, COGS $0.018 → ~10× margin.

**v2 with ElevenLabs voice**: COGS rises to ~$0.06/video. Still profitable at 1 credit; healthy margin tightens.

**v3 with AI-generated b-roll**: COGS jumps to $5–$45/video depending on length and provider. Not viable at 1 credit. Two paths:
- "Premium video" tier at 10–20 credits/video.
- Wait for prices to drop (they will; this is moving fast).

The user's instruction was "1 credit per video. etc. etc. same pricing dynamics." Faithfully: v1+v2 stay at 1 credit. v3 introduces a tier. PRD flags this for product decision before v3.

---

## 6. AI script prompt (sketch)

```
You're writing a 30–60 second short-form vertical video script for a
{niche} audience on {platform}.

Brand: {brand_name}
Brand one-liner: {brand_one_liner}
Audience: {target_audience}
Topic: {topic}

Structure:
- HOOK (3 seconds, ~10 words). A surprising claim or pain point.
  Pattern: "Most teams think X. Actually Y." or "Here's what nobody
  tells you about X."
- BEATS (2–4 of them, 8–15 seconds each). One idea per beat.
- CTA (5 seconds). Soft, tied to the brand. Not "click the link"; not
  "comment below." Something like "If your team is dealing with X,
  {brand} solves it" or "Full breakdown on {brand}."

Voice: direct, technical-but-readable, slightly skeptical of hype.
Same operator-voice you use for our blog posts.

Output strict JSON:
{
  "hook": "...",
  "beats": ["...","...", ...],
  "cta": "...",
  "full_script": "...",            // the whole thing as the TTS will read it
  "noun_phrases": ["...", ...]    // 3–5 phrases for Pexels b-roll queries
}
```

---

## 7. Worker jobs

| Job | Schedule | Purpose |
|---|---|---|
| `vid.script` | per-job | Claude call → write script + noun phrases. |
| `vid.voice` | per-job | OpenAI TTS → MP3 → Supabase Storage. |
| `vid.broll` | per-job | Pexels search + download per noun phrase. |
| `vid.compose` | per-job | Remotion bundle + render → MP4 → Supabase Storage. |
| `vid.distribute` | post-render | Hand off to Social Posting layer (Phase 2). |
| `vid.cleanup` | daily | Delete `vid_job` artifacts older than 30 days. |

All stages run in a dedicated `viral-video-worker` Railway service because the Remotion render needs Chromium + bigger memory than the autoblog worker.

---

## 8. UI surface (under `app/(app)/videos/`)

| Route | Shows |
|---|---|
| `/videos/setup` | Per-site video config: voice, aspect ratio, weekly cadence, distribution platforms. |
| `/videos` | Dashboard: render queue, recent renders (thumbnails), credit balance. |
| `/videos/new` | One-shot manual: topic + duration + voice → "Render now". |
| `/videos/[id]` | Single video: inline player, script text, distribution status, download MP4. |

---

## 9. API surface

Under `app/api/vid/`:

- `POST /api/vid/job` — create a render job (auto OR manual).
- `GET  /api/vid/job/[id]` — status + artifacts.
- `POST /api/vid/job/[id]/distribute` — push to social posting (Phase 2).
- `DELETE /api/vid/job/[id]` — cancel queued, hide rendered.

Internal:
- `POST /api/cron/vid-scheduled` — hourly cron picks per-site cadence and creates jobs.

---

## 10. Pricing model

**1 credit per rendered video, regardless of length within the 15–90s range.**

| Event | Credits |
|---|---|
| `vid_job` reaches `status='ready'` | 1 |
| Distribution to N social platforms (via Social Posting) | N (one per platform per §10 of social-posting-prd.md) |
| Cancelled before render starts | 0 |
| Failed render (any stage) | 0 (we eat the COGS, no charge to user) |

Refund policy: a failed render does not charge a credit. The COGS so far (~$0.01 if the failure was after script + voice) is small enough that we eat it. If we see >5% failure rate, address the root cause rather than recouping.

**A typical customer using all three features:**
- 1 article/day × 22 weekdays = 22 credits/month (autoblog)
- That article fans out to 5 social platforms = 110 credits/month (social posting)
- 1 video/day × 22 weekdays + same 5-platform fanout = 22 + 110 = 132 credits/month (video)
- **Total: ~264 credits/month**. At Pro pack ($99/500 credits = $0.198/credit), this is ~$52 of credits/month, ~2 months of Pro pack burn.

Pricing tiers in `lib/credits-finalize.ts` will need to be revisited once video lands; the current Starter/Growth/Pro caps assume autoblog-only consumption.

---

## 11. Risks & mitigations

- **Pexels API rate limits.** 200/hr. At one video/day per customer with 5 phrases, 100 customers = 500/hr peak — over limit. Mitigation: cache common queries (`niche → top clips`) in `vid_broll_cache` table with 7-day TTL.
- **Render queue backup.** Remotion render is the slowest stage (~90s/video). At 100 videos/day across all customers, one box renders ~1000/day. Plenty of headroom; scale workers horizontally if needed.
- **TikTok upload approval.** TikTok's Content Publishing API requires app review and the criteria are vague. We may be stuck doing browser-automation for TikTok specifically (see Social Posting PRD §5).
- **Generic/slop output.** The biggest reputation risk. Mitigation: the same operator-voice prompt that keeps autoblog posts technical and useful applies to video scripts; the niche filter on social posting (per Social Posting PRD §5) rejects off-niche videos before they distribute.
- **Copyright on music.** Royalty-free libraries are not always actually royalty-free internationally. Mitigation: stick to libraries with explicit "free for commercial use, no attribution" licenses (Pixabay Music) and document the license in `lib/vid/music/LICENSES.md`.
- **Voice cloning ethics.** v2 ElevenLabs supports custom voices. We will NOT allow customers to upload arbitrary voice samples — only library voices. Custom-voice + auto-post = deepfake at scale; not a place we want to be.
- **AI video provenance / detection.** Platforms (TikTok especially) are starting to flag AI-generated content. We honor any platform-required disclosure flags (e.g. TikTok's `aigc_label`) in the upload metadata.

---

## 12. Out of scope for v1

- Talking-head avatars (HeyGen-style)
- AI b-roll generation (v3 only)
- Multi-language voice (English-only v1)
- Per-platform aspect-ratio variants (9:16 only)
- Brand kit upload (custom logo / color / font)
- Watermark / outro card customization
- A/B testing variations of the same script
- Editing UI ("re-record this line", "swap this clip")
- Live streaming generation

---

## 13. Build sequence

1. **Migration** — `supabase/migrations/NNNN_viral_video.sql` (§4).
2. **Storage bucket** — `lx-video-renders` public bucket via same migration.
3. **Script + voice pipeline** — `lib/vid/script.ts` + `lib/vid/voice.ts`. Output: an MP3 in a `tmp/` dir. Smallest working unit.
4. **Pexels b-roll fetcher** — `lib/vid/broll.ts`. Output: 5 MP4 clips in `tmp/`.
5. **Remotion composition** — `lib/vid/compose/`. React components for hook → beats → cta with caption animation. Test render locally before wiring to the worker.
6. **Worker integration** — `worker/vid/render.ts`. End-to-end one-shot render.
7. **Dashboard UI** — 3 routes (§8). Renders a video to inline `<video>` player.
8. **Distribution** — wire `vid_job.public_url` through to Social Posting (depends on that PRD shipping).
9. **Scheduled cron** — generate per-site videos on a cadence.
10. **Premium voice (ElevenLabs)** — config flag per user.

---

## 14. Open questions for before build

- **Remotion vs. raw FFmpeg + Lottie.** Remotion is the developer-experience win; FFmpeg is the operational simplicity win. Decide based on whether kinetic typography is worth the bundle weight.
- **Where to run the render worker.** Railway works but Remotion needs >2GB RAM; need a beefier service tier.
- **Watermark policy.** Do we burn-in "Made with Crawlproof" on free-tier videos? Free marketing vs. customer annoyance.
- **AI-disclosure stance.** Do we proactively add metadata flags identifying these as AI-generated, or wait for platforms to require them?
- **Voice library**. Three OpenAI TTS voices in v1; need to pick which three feel most on-brand.
- **Music library curation**. Need 10–20 royalty-free tracks across major niches before v1 ships. Whose job is this — designer? Founder?

---

## 15. Dependencies on other PRDs

- **Autoblog (`docs/link-exchange-prd.md`)** — shipped; provides the per-site config (niche, audience, brand_one_liner) that the video pipeline reuses.
- **Social Posting (`docs/social-posting-prd.md`)** — PRD'd but not shipped. Video distribution depends on the Social Posting layer being live for TikTok/Reels/Shorts.
- **Credit ledger (`lib/credits-finalize.ts`)** — existing. Video consumes 1 credit per render; need to add the `vid_render` reason code to the existing ledger.
