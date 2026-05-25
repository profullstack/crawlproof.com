-- Event/page/referrer rollups for the drop-in stats tracker. We still avoid
-- raw visitor sessions and cookies; this keeps analytics useful while storing
-- only daily aggregate slices.
create table if not exists public.tracker_event_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  event text not null,
  page_path text not null default '',
  referrer_host text not null default '',
  event_target text not null default '',
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, day, event, page_path, referrer_host, event_target)
);

create index if not exists tracker_event_daily_stats_project_day_idx
  on public.tracker_event_daily_stats(project_id, day desc);

create index if not exists tracker_event_daily_stats_project_event_idx
  on public.tracker_event_daily_stats(project_id, event);

alter table public.tracker_event_daily_stats enable row level security;

create policy "tracker_event_daily_stats owner select"
  on public.tracker_event_daily_stats for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

-- Service role writes from /api/track; end users only read their own rollups.
