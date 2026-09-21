-- Visitors: the tracker learns to count people.
--
-- WHY: every headline the dashboards led with was a count of EVENTS. The
-- bucket rollup (tracker_daily_stats) is bumped once per beacon, and stats.js
-- fires a beacon for the pageview, four scroll depths, every click and every
-- form submit, so "Human visits" was ~3-4 events per page view from anything
-- whose user agent did not say bot. On four properties that read as 51,531
-- "human visits" in a week while the raw event table held 420 distinct
-- visitor ids in a day, which is also what an independent analytics tool
-- reported. Nothing outside the 24h raw table kept a visitor id, so the
-- product could not state weekly unique visitors at all.
--
-- WHAT:
--   1. tracker_visitor_daily_stats — one row per (project, UTC day, visitor),
--      with the event and pageview counts for that visitor that day and which
--      side of the human / bot line the visitor ended the day on. Row count is
--      visitors x days, not events, so it keeps.
--   2. tracker_touch_visitor — the per-beacon upsert. Returns the visitor's
--      counts after the increment so the ingest route can make one round
--      trip. It also applies the SCRIPTED cap: a "visitor" that produces more
--      than p_cap_events events or p_cap_pageviews page views in one UTC day
--      is not a person reading a website, it is a browser being driven
--      (the ones seen so far: 398 events on 4 page views, 126 page views from
--      one id, ~1 fresh id per page view from a headless Chrome). The row is
--      flipped to kind = 'bot' and stays there for the day; the route then
--      counts every later beacon from it under bot:scripted.
--   3. tracker_visitor_totals — distinct visitors and their page views over a
--      window and the equal-length window before it, per project. Exact
--      uniques, because the ids are here.
--   4. tracker_visitor_daily_series — visitors per (project, day), for the
--      dashboard sparklines and the stats page.
--
-- ROWS BEGIN THE DAY THIS IS APPLIED. There is no history to backfill from:
-- tracker_events keeps 24h. The UI says so beside every visitor figure.
--
-- security invoker throughout; RLS mirrors tracker_daily_stats (owner or
-- member may read). The ingest route writes with the service role.
-- Idempotent. Apply one file at a time via the Supabase MCP, not `db push`.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.tracker_visitor_daily_stats (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  visitor_id text not null,
  kind text not null default 'human' check (kind in ('human', 'bot')),
  events integer not null default 0,
  pageviews integer not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (project_id, day, visitor_id)
);

-- The read RPCs count rows per (project, day, kind); the PK prefix covers
-- (project, day) but the filter on kind and the pageviews sum need this.
create index if not exists tracker_visitor_daily_stats_project_day_kind_idx
  on public.tracker_visitor_daily_stats (project_id, day, kind)
  include (pageviews);

alter table public.tracker_visitor_daily_stats enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tracker_visitor_daily_stats'
      and policyname = 'tracker_visitor_daily_stats owner select'
  ) then
    create policy "tracker_visitor_daily_stats owner select"
      on public.tracker_visitor_daily_stats
      for select
      using (
        project_id in (select id from public.projects where owner_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'tracker_visitor_daily_stats'
      and policyname = 'tracker_visitor_daily_stats member select'
  ) then
    create policy "tracker_visitor_daily_stats member select"
      on public.tracker_visitor_daily_stats
      for select
      using (public.is_project_member(project_id, auth.uid()));
  end if;
end $$;

grant select on public.tracker_visitor_daily_stats to authenticated;
grant select, insert, update, delete on public.tracker_visitor_daily_stats to service_role;

-- ---------------------------------------------------------------------------
-- 2. Per-beacon touch (+ scripted cap)
-- ---------------------------------------------------------------------------
create or replace function public.tracker_touch_visitor(
  p_project uuid,
  p_day date,
  p_visitor text,
  p_kind text,
  p_pageview boolean,
  p_cap_events integer default 500,
  p_cap_pageviews integer default 200
)
returns table (kind text, events integer, pageviews integer)
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.tracker_visitor_daily_stats as s
    (project_id, day, visitor_id, kind, events, pageviews, first_seen, last_seen)
  values
    (p_project, p_day, p_visitor,
     -- A single beacon can already blow the cap when the cap is 0; keep the
     -- rule in one place by evaluating it on the insert too.
     case
       when p_kind = 'bot' then 'bot'
       when 1 > coalesce(p_cap_events, 500) then 'bot'
       when (case when p_pageview then 1 else 0 end) > coalesce(p_cap_pageviews, 200) then 'bot'
       else 'human'
     end,
     1, (case when p_pageview then 1 else 0 end), now(), now())
  on conflict (project_id, day, visitor_id) do update
    set events = s.events + 1,
        pageviews = s.pageviews + (case when p_pageview then 1 else 0 end),
        last_seen = now(),
        -- Sticky: once a bot (by user agent or by volume), a bot for the day.
        kind = case
          when s.kind = 'bot' or p_kind = 'bot' then 'bot'
          when s.events + 1 > coalesce(p_cap_events, 500) then 'bot'
          when s.pageviews + (case when p_pageview then 1 else 0 end) > coalesce(p_cap_pageviews, 200) then 'bot'
          else 'human'
        end
  returning s.kind, s.events, s.pageviews;
$$;

revoke all on function public.tracker_touch_visitor(uuid, date, text, text, boolean, integer, integer) from public;
grant execute on function public.tracker_touch_visitor(uuid, date, text, text, boolean, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Window totals: distinct visitors + their page views, current and previous
-- ---------------------------------------------------------------------------
create or replace function public.tracker_visitor_totals(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
)
returns table (
  project_id uuid,
  visitors bigint,
  prev_visitors bigint,
  pageviews bigint,
  prev_pageviews bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select (today - (n - 1)) as cur_start,
           (today - (2 * n - 1)) as prev_start,
           (today - n) as prev_end
    from (
      select greatest(coalesce(days, 30), 1) as n,
             (now() at time zone 'UTC')::date as today
    ) win
  )
  select s.project_id,
         count(distinct s.visitor_id) filter (where s.day >= b.cur_start)::bigint as visitors,
         count(distinct s.visitor_id) filter (where s.day <= b.prev_end)::bigint as prev_visitors,
         coalesce(sum(s.pageviews) filter (where s.day >= b.cur_start), 0)::bigint as pageviews,
         coalesce(sum(s.pageviews) filter (where s.day <= b.prev_end), 0)::bigint as prev_pageviews
  from public.tracker_visitor_daily_stats s
  cross join bounds b
  where s.project_id = any(p_projects)
    and s.day >= b.prev_start
    and (p_kind is null or s.kind = p_kind)
  group by s.project_id;
$$;

grant execute on function public.tracker_visitor_totals(uuid[], integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Daily series: visitors per (project, day)
-- ---------------------------------------------------------------------------
create or replace function public.tracker_visitor_daily_series(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
)
returns table (project_id uuid, day date, visitors bigint, pageviews bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select s.project_id,
         s.day,
         count(*)::bigint as visitors,
         coalesce(sum(s.pageviews), 0)::bigint as pageviews
  from public.tracker_visitor_daily_stats s
  where s.project_id = any(p_projects)
    and s.day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
    and (p_kind is null or s.kind = p_kind)
  group by s.project_id, s.day
  order by s.project_id, s.day;
$$;

grant execute on function public.tracker_visitor_daily_series(uuid[], integer, text) to authenticated, service_role;
