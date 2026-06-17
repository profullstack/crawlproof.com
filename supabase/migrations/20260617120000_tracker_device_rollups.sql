-- Daily device rollups for the drop-in stats tracker. /api/track derives
-- coarse device type / browser / OS buckets from the request User-Agent and
-- writes only aggregate counts — no raw UA strings are stored, keeping this in
-- line with the cookie-free, PII-light design of the other tracker tables.
create table if not exists public.tracker_device_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  device_type text not null default '',
  browser text not null default '',
  os text not null default '',
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, day, device_type, browser, os)
);

create index if not exists tracker_device_daily_stats_project_day_idx
  on public.tracker_device_daily_stats(project_id, day desc);

alter table public.tracker_device_daily_stats enable row level security;

create policy "tracker_device_daily_stats owner select"
  on public.tracker_device_daily_stats for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

-- Members of a project may read its device stats (mirrors the member-select
-- policies on the other tracker_*_daily_stats tables).
create policy "tracker_device_daily_stats member select"
  on public.tracker_device_daily_stats for select
  using (
    exists(
      select 1 from public.project_members
      where project_id = tracker_device_daily_stats.project_id
        and user_id = auth.uid()
    )
  );

-- Service role writes from /api/track; end users only read their own rollups.
