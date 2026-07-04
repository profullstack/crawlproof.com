-- Daily exit-page rollups for the drop-in stats tracker. The "exit page" of a
-- session is its most recent pageview: the last page a visitor was on before
-- leaving. We can't know at ingest time whether a given pageview is the last
-- one, so we keep a small per-session "current last page" record and *move* the
-- exit marker as the session advances (decrement the old page, increment the
-- new one). tracker_exit_daily_stats therefore always reflects, for each
-- session, exactly one exit page — its latest pageview so far.
--
-- Consistent with the other tracker_*_daily_stats tables: cookie-free, no raw
-- PII, only aggregate counts.
create table if not exists public.tracker_exit_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  page_path text not null default '',
  count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, day, page_path)
);

create index if not exists tracker_exit_daily_stats_project_day_idx
  on public.tracker_exit_daily_stats(project_id, day desc);

alter table public.tracker_exit_daily_stats enable row level security;

create policy "tracker_exit_daily_stats owner select"
  on public.tracker_exit_daily_stats for select
  using (
    project_id in (select id from public.projects where owner_id = auth.uid())
  );

-- Members of a project may read its exit stats (mirrors the member-select
-- policies on the other tracker_*_daily_stats tables).
create policy "tracker_exit_daily_stats member select"
  on public.tracker_exit_daily_stats for select
  using (
    exists(
      select 1 from public.project_members
      where project_id = tracker_exit_daily_stats.project_id
        and user_id = auth.uid()
    )
  );

-- Internal bookkeeping: the current last pageview per session, used to move the
-- exit marker in tracker_exit_daily_stats. Written only by the service role
-- from /api/track; never read by end users, so we enable RLS with no select
-- policy (the service role bypasses RLS). Rows are pruned once well past the
-- client-side 30-minute session TTL so a session id can never be re-counted.
create table if not exists public.tracker_exit_sessions (
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id text not null,
  last_page_path text not null default '',
  last_day date not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, session_id)
);

create index if not exists tracker_exit_sessions_project_updated_idx
  on public.tracker_exit_sessions(project_id, updated_at);

alter table public.tracker_exit_sessions enable row level security;

-- Service role writes from /api/track; no public read access.
