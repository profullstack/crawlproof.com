-- Drop-in stats tracker: customers paste a <script src="…/stats.js"> tag and
-- pageviews / AI-bot crawls flow into tracker_daily_stats. We aggregate at
-- ingest time (UPSERT + increment) rather than storing raw events, so the
-- footprint stays small even for sites with heavy traffic.

-- Per-project opt-in. Defaults off until the owner activates from the
-- project Stats tab. Billing (1 credit / site / month) hooks off this flag.
alter table public.projects
  add column if not exists tracker_enabled boolean not null default false;

alter table public.projects
  add column if not exists tracker_enabled_at timestamptz;

create index if not exists projects_tracker_enabled_idx
  on public.projects(tracker_enabled) where tracker_enabled;

-- Per-day, per-bucket count. Bucket is a free-form string the categorizer
-- emits, e.g. 'human:direct', 'ai_referral:chatgpt', 'ai_referral:perplexity',
-- 'bot:gptbot', 'search:google'. PK (project_id, day, bucket) gives us cheap
-- ON CONFLICT increments.
create table if not exists public.tracker_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  bucket text not null,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, day, bucket)
);

create index if not exists tracker_daily_stats_project_day_idx
  on public.tracker_daily_stats(project_id, day desc);

alter table public.tracker_daily_stats enable row level security;

create policy "tracker_daily_stats owner select"
  on public.tracker_daily_stats for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

-- Service role writes from /api/track (uses createServiceClient), so no
-- INSERT/UPDATE policies needed for end users.
