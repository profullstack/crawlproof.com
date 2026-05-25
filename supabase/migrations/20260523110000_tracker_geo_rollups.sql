-- Daily location rollups for tracker events. No raw IP addresses are stored;
-- /api/track derives these fields from a local MaxMind GeoLite2 database and
-- writes only aggregate counts.
create table if not exists public.tracker_geo_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  country_code text not null default '',
  country_name text not null default '',
  region_code text not null default '',
  region_name text not null default '',
  city text not null default '',
  timezone text not null default '',
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (
    project_id,
    day,
    country_code,
    region_code,
    city,
    timezone
  )
);

create index if not exists tracker_geo_daily_stats_project_day_idx
  on public.tracker_geo_daily_stats(project_id, day desc);

create index if not exists tracker_geo_daily_stats_project_country_idx
  on public.tracker_geo_daily_stats(project_id, country_code);

alter table public.tracker_geo_daily_stats enable row level security;

create policy "tracker_geo_daily_stats owner select"
  on public.tracker_geo_daily_stats for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

-- Service role writes from /api/track; end users only read their own rollups.
