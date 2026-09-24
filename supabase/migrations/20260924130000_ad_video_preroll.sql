-- Streaming pre-roll: the five-second video ad format.
--
-- Adds `video_preroll_5s`, a creative served as media a viewer plays before a
-- stream rather than as a document a renderer produces. Work package A of the
-- streaming-ads spec: schema and format registration only. Nothing here renders
-- an MP4, selects one, or serves one — those are packages B and D.
--
-- This deliberately does NOT follow the shape of the last two format additions
-- (20260730120000_ad_terminal_ascii, 20260818120000_ad_feed_item). Both of
-- those widened the creative CHECK, added the format to every slot's inventory,
-- and backfilled a creative per campaign from copy that already existed. Steps
-- 2 and 3 are wrong for a media format, and the reason is the same for each:
--
--   * Slot inventory drives serveAd(), which renders HTML and ASCII. Adding the
--     format there would offer a video to the display path. Streaming
--     publishers register an ad_streaming_property instead, and video is
--     selected by the playback decision endpoint, which checks for a published
--     media revision before it will hand anything to a player.
--
--   * A backfill can clone a headline. It cannot clone a 150-frame H.264
--     encode. Cloning the copy alone would mint rows that look `ready` and have
--     no bytes behind them — an unrendered video that a serving path would be
--     entitled to pick. Video creatives are created by the render pipeline,
--     which sets published_revision only once ffprobe has validated the output.
--
-- So the invariant this migration is responsible for is the narrow one: the
-- format exists and is storable, and nothing that exists today can serve it.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`.

-- 1. Widen the creative format CHECK. -----------------------------------------

alter table public.ad_creatives drop constraint if exists ad_creatives_format_check;
alter table public.ad_creatives
  add constraint ad_creatives_format_check
  check (format in (
    'banner_300x250', 'banner_728x90', 'banner_320x50',
    'text_link', 'terminal_ascii', 'feed_item', 'video_preroll_5s'
  ));

-- 2. Media revision pointers on the creative. ---------------------------------
--
-- `requested_revision` is the design revision the advertiser last asked for;
-- `published_revision` is the one that has validated media behind it. They are
-- equal on a settled video creative and differ while a render is in flight.
--
-- published_revision NULL is the load-bearing state: it means "no validated
-- media", and it is what selection filters on. A video creative therefore
-- starts unservable by construction rather than by remembering to check.
--
-- Both are null for every non-video creative and every row that exists today;
-- the display formats have no media and no revisions.
alter table public.ad_creatives
  add column if not exists requested_revision integer,
  add column if not exists published_revision integer;

alter table public.ad_creatives drop constraint if exists ad_creatives_revision_check;
alter table public.ad_creatives
  add constraint ad_creatives_revision_check check (
    (format <> 'video_preroll_5s' and requested_revision is null and published_revision is null)
    or (format = 'video_preroll_5s' and requested_revision is not null and requested_revision > 0)
  );

-- One video creative per campaign. The pre-roll is a single placement; a second
-- one would only ever be ambiguity about which plays.
create unique index if not exists ad_creatives_one_video_per_campaign
  on public.ad_creatives(campaign_id)
  where format = 'video_preroll_5s';

-- 3. Render jobs. -------------------------------------------------------------
--
-- A job is keyed by a hash of its immutable inputs (design snapshot, source
-- asset hashes, locale, audio mode, renderer version, output profile), so an
-- unchanged design reuses a finished result instead of re-encoding it.
--
-- creative_id is nullable because a preview render is started from the Generate
-- Ads screen before any campaign is saved. A preview job is owner-scoped and
-- can never be bound to serving until saveCampaign adopts it.
create table if not exists public.ad_video_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid references public.ad_campaigns(id) on delete cascade,
  creative_id uuid references public.ad_creatives(id) on delete cascade,
  revision integer not null check (revision > 0),
  render_hash text not null,
  output_profile text not null default 'default',
  design jsonb not null default '{}'::jsonb,
  renderer_version text not null default '',
  state text not null default 'queued'
    check (state in ('queued','rendering','validating','ready','failed')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 3),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A preview job has no campaign; a campaign job must belong to the campaign's
  -- creative when it has one.
  constraint ad_video_jobs_preview_or_campaign
    check (campaign_id is not null or creative_id is null)
);

-- The dedupe key: identical inputs are one job, whoever asks and however often.
create unique index if not exists ad_video_jobs_render_hash_key
  on public.ad_video_jobs(render_hash, output_profile);
create index if not exists ad_video_jobs_owner_idx on public.ad_video_jobs(owner_id);
create index if not exists ad_video_jobs_creative_idx on public.ad_video_jobs(creative_id);
-- Queue drain order, and the index the depth alert reads.
create index if not exists ad_video_jobs_pending_idx
  on public.ad_video_jobs(created_at)
  where state in ('queued','rendering','validating');

-- 4. Rendered media. ----------------------------------------------------------
--
-- One row per (creative, revision, profile): the 1080p downloadable master, the
-- 720p/480p delivery MP4s, the HLS package, the poster, captions, and the audio
-- companion are each a profile. Rows are append-only — a new revision never
-- overwrites an old one, because a decision already issued pins the revision it
-- promised and must keep resolving to the bytes the viewer was sent.
create table if not exists public.ad_video_assets (
  id uuid primary key default gen_random_uuid(),
  creative_id uuid not null references public.ad_creatives(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null check (revision > 0),
  profile text not null
    check (profile in ('master_1080p','mp4_720p','mp4_480p','hls','poster','captions','audio')),
  object_key text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null,
  width integer,
  height integer,
  -- Measured by ffprobe on the encoded output, never copied from the request.
  duration_ms integer,
  codecs text,
  validation jsonb not null default '{}'::jsonb,
  published boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists ad_video_assets_rev_profile_key
  on public.ad_video_assets(creative_id, revision, profile);
create index if not exists ad_video_assets_published_idx
  on public.ad_video_assets(creative_id, revision)
  where published;

-- 5. Streaming properties. ----------------------------------------------------
--
-- The publisher side of a video fill. A property is a streaming site or app
-- that has been registered, tested and enabled; its backend authenticates with
-- a property-scoped credential and is the only thing allowed to assert whether
-- a viewer needs an ad.
--
-- `integration_mode` records which of the spec's three delivery profiles was
-- tested for this property, because a browser integration does not imply a
-- receiver one and enabling the wrong one ships a broken pre-roll.
create table if not exists public.ad_streaming_properties (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  property_key text not null,
  domain text not null,
  allowed_origins text[] not null default '{}',
  slot_id uuid references public.ad_slots(id) on delete set null,
  credential_ref text,
  integration_mode text not null default 'client_preroll'
    check (integration_mode in ('client_preroll','hls_interstitial','server_manifest')),
  -- Which presentations this property's slot may be filled with. Terminal text
  -- substitution is off unless explicitly listed: it is a different placement,
  -- not a fallback the server may choose on a publisher's behalf.
  allowed_presentations text[] not null default array['video'],
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ad_streaming_properties_key on public.ad_streaming_properties(property_key);
create index if not exists ad_streaming_properties_owner_idx on public.ad_streaming_properties(owner_id);

-- 6. Playback decisions. ------------------------------------------------------
--
-- One row per playback session per placement — that uniqueness is the whole
-- per-session pre-roll rule. A duplicate request returns the row that already
-- exists, so a reconnect, a playlist reload, a player remount or a retried
-- request cannot stack a second ad onto a session that already had one.
--
-- `outcome` is terminal state for the session: once it says completed or
-- failed_open, that session is done regardless of what a client reports later.
create table if not exists public.ad_video_decisions (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.ad_streaming_properties(id) on delete cascade,
  playback_session_id text not null,
  placement text not null default 'preroll',
  slot_id uuid references public.ad_slots(id) on delete set null,
  campaign_id uuid references public.ad_campaigns(id) on delete set null,
  creative_id uuid references public.ad_creatives(id) on delete set null,
  asset_revision integer,
  result text not null
    check (result in ('ad','house','no_ad','unsupported_playback')),
  reason text,
  delivery text
    check (delivery in ('client_mp4','hls_interstitial','server_manifest','terminal_card')),
  presentation_kind text not null default 'video'
    check (presentation_kind in ('video','audio','terminal_text')),
  surface text not null default 'web'
    check (surface in ('web','pwa','desktop','cli','tui','headless')),
  -- The destination as promised at decision time. The click redirect resolves
  -- from here, so editing a campaign's URL afterwards cannot redirect a viewer
  -- who was shown the old claim to a different place.
  destination_url text,
  entitlement_checked_at timestamptz,
  -- Set once, by the first accepted `start`. Its presence is what a click
  -- checks before it is allowed to bill.
  impression_id uuid references public.ad_impressions(id) on delete set null,
  outcome text
    check (outcome in ('completed','abandoned','error','fail_open','entitlement_changed')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists ad_video_decisions_session_key
  on public.ad_video_decisions(property_id, playback_session_id, placement);
create index if not exists ad_video_decisions_campaign_idx on public.ad_video_decisions(campaign_id);
create index if not exists ad_video_decisions_created_idx on public.ad_video_decisions(created_at);

-- 7. Playback events. ---------------------------------------------------------
--
-- Client-reported measurements, kept separate from the impression ledger on
-- purpose. A decision is not an impression, a byte range is not a view, and a
-- text card is not a video completion; keeping these here means none of them
-- can be mistaken for one by a reporting query that joins the wrong table.
create table if not exists public.ad_video_events (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.ad_video_decisions(id) on delete cascade,
  event_id text not null,
  event_type text not null check (event_type in (
    'asset_requested','start','first_quartile','midpoint','third_quartile',
    'complete','click','error','abandon','entitlement_changed','fail_open',
    'text_start','text_complete'
  )),
  media_time_ms integer check (media_time_ms >= 0),
  played_ms integer check (played_ms >= 0),
  measurement_source text not null default 'media_element',
  error_reason text,
  client_ts timestamptz,
  received_at timestamptz not null default now()
);

-- One-shot progress events dedupe by type; repeated diagnostics dedupe by the
-- client's own event id.
create unique index if not exists ad_video_events_once_key
  on public.ad_video_events(decision_id, event_type)
  where event_type in (
    'start','first_quartile','midpoint','third_quartile','complete',
    'text_start','text_complete'
  );
create unique index if not exists ad_video_events_event_id_key
  on public.ad_video_events(decision_id, event_id);

-- 8. RLS. ---------------------------------------------------------------------
--
-- Advertisers see their own render jobs and media. Decisions and events are
-- written by the service-role client from an authenticated property backend and
-- are never readable by an end user, so they get RLS with no public policy —
-- the same shape ad_impressions uses.

alter table public.ad_video_jobs enable row level security;
alter table public.ad_video_assets enable row level security;
alter table public.ad_streaming_properties enable row level security;
alter table public.ad_video_decisions enable row level security;
alter table public.ad_video_events enable row level security;

drop policy if exists "own video jobs" on public.ad_video_jobs;
create policy "own video jobs" on public.ad_video_jobs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "own video assets" on public.ad_video_assets;
create policy "own video assets" on public.ad_video_assets
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "own streaming properties" on public.ad_streaming_properties;
create policy "own streaming properties" on public.ad_streaming_properties
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Keep updated_at honest on the two tables that are edited in place.
drop trigger if exists ad_video_jobs_touch on public.ad_video_jobs;
create trigger ad_video_jobs_touch before update on public.ad_video_jobs
  for each row execute function public.ad_campaigns_touch();

drop trigger if exists ad_streaming_properties_touch on public.ad_streaming_properties;
create trigger ad_streaming_properties_touch before update on public.ad_streaming_properties
  for each row execute function public.ad_campaigns_touch();
