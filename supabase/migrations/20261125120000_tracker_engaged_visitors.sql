-- Engaged visitors: a human visitor whose browser showed a person was there.
--
-- WHY: "Human visitors" is every visitor id the user agent did not give away,
-- and on 2026-11-25 the fleet read ~579k of them in 30 days. Most are swarms
-- that open each page in a fresh headless browser with a current Chrome UA:
-- nichedb.dev had 234,792 "human visitors" and only 268 with two or more page
-- views in a day. The previous proxy (20261017120000: events >= 2) also
-- counts a scroll beacon a script can fire without anyone present.
--
-- stats.js now sends one `engaged` beacon per page view when the page sees
-- real input (a trusted pointerdown, keydown, touchstart or wheel) or has
-- been visible and focused for 10 seconds, and never when navigator.webdriver
-- is set. The ingest route passes p_engaged = true for that beacon.
--
-- WHAT:
--   1. tracker_visitor_daily_stats.engaged — true once the visitor sent an
--      engaged beacon that UTC day. Never true on a bot row: the check below
--      holds it, and the touch clears it on the beacon that flips a row to
--      bot (user agent, declared agent, or the scripted cap).
--   2. tracker_touch_visitor gains p_engaged (default false) and returns
--      engaged. Dropped and recreated rather than overloaded: two candidates
--      with the same named arguments make PostgREST refuse the call. Old
--      callers that omit p_engaged keep working.
--   3. tracker_visitor_totals and tracker_visitor_daily_series return engaged
--      counts beside visitors (distinct engaged visitors in the window).
--   4. tracker_visitor_engagement (the nightly digest) counts this column
--      instead of events >= 2.
--
-- Rows written before this is applied are engaged = false: there is nothing
-- to backfill from. The UI says engaged counts start on ENGAGED_SINCE.
-- Idempotent. Apply one file at a time, not `db push`.

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
alter table public.tracker_visitor_daily_stats
  add column if not exists engaged boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tracker_visitor_daily_stats_engaged_human'
      and conrelid = 'public.tracker_visitor_daily_stats'::regclass
  ) then
    alter table public.tracker_visitor_daily_stats
      add constraint tracker_visitor_daily_stats_engaged_human
      check (not engaged or kind = 'human');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Per-beacon touch (+ scripted cap, + engaged)
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_touch_visitor(uuid, date, text, text, boolean, integer, integer);
drop function if exists public.tracker_touch_visitor(uuid, date, text, text, boolean, integer, integer, boolean);

create function public.tracker_touch_visitor(
  p_project uuid,
  p_day date,
  p_visitor text,
  p_kind text,
  p_pageview boolean,
  p_cap_events integer default 500,
  p_cap_pageviews integer default 200,
  p_engaged boolean default false
)
returns table (kind text, events integer, pageviews integer, engaged boolean)
language sql
volatile
security invoker
set search_path = public
as $$
  with ins as (
    select case
             when p_kind = 'bot' then 'bot'
             when 1 > coalesce(p_cap_events, 500) then 'bot'
             when (case when p_pageview then 1 else 0 end) > coalesce(p_cap_pageviews, 200) then 'bot'
             else 'human'
           end as kind
  )
  insert into public.tracker_visitor_daily_stats as s
    (project_id, day, visitor_id, kind, events, pageviews, engaged, first_seen, last_seen)
  select p_project, p_day, p_visitor, ins.kind,
         1, (case when p_pageview then 1 else 0 end),
         (ins.kind = 'human' and coalesce(p_engaged, false)),
         now(), now()
  from ins
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
        end,
        -- Sticky too, but only while the row stays human: the same test as
        -- `kind` above, so a beacon that flips the row to bot clears it.
        engaged = case
          when s.kind = 'bot' or p_kind = 'bot' then false
          when s.events + 1 > coalesce(p_cap_events, 500) then false
          when s.pageviews + (case when p_pageview then 1 else 0 end) > coalesce(p_cap_pageviews, 200) then false
          else s.engaged or coalesce(p_engaged, false)
        end
  returning s.kind, s.events, s.pageviews, s.engaged;
$$;

revoke all on function public.tracker_touch_visitor(uuid, date, text, text, boolean, integer, integer, boolean) from public;
grant execute on function public.tracker_touch_visitor(uuid, date, text, text, boolean, integer, integer, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Window totals and daily series, now with engaged visitors
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_visitor_totals(uuid[], integer, text);

create function public.tracker_visitor_totals(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
)
returns table (
  project_id uuid,
  visitors bigint,
  prev_visitors bigint,
  pageviews bigint,
  prev_pageviews bigint,
  engaged bigint,
  prev_engaged bigint
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
         coalesce(sum(s.pageviews) filter (where s.day <= b.prev_end), 0)::bigint as prev_pageviews,
         count(distinct s.visitor_id) filter (where s.day >= b.cur_start and s.engaged)::bigint as engaged,
         count(distinct s.visitor_id) filter (where s.day <= b.prev_end and s.engaged)::bigint as prev_engaged
  from public.tracker_visitor_daily_stats s
  cross join bounds b
  where s.project_id = any(p_projects)
    and s.day >= b.prev_start
    and (p_kind is null or s.kind = p_kind)
  group by s.project_id;
$$;

grant execute on function public.tracker_visitor_totals(uuid[], integer, text) to authenticated, service_role;

drop function if exists public.tracker_visitor_daily_series(uuid[], integer, text);

create function public.tracker_visitor_daily_series(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
)
returns table (project_id uuid, day date, visitors bigint, pageviews bigint, engaged bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select s.project_id,
         s.day,
         count(*)::bigint as visitors,
         coalesce(sum(s.pageviews), 0)::bigint as pageviews,
         count(*) filter (where s.engaged)::bigint as engaged
  from public.tracker_visitor_daily_stats s
  where s.project_id = any(p_projects)
    and s.day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
    and (p_kind is null or s.kind = p_kind)
  group by s.project_id, s.day
  order by s.project_id, s.day;
$$;

grant execute on function public.tracker_visitor_daily_series(uuid[], integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Nightly digest: engaged = the beacon, not events >= 2
-- ---------------------------------------------------------------------------
create or replace function public.tracker_visitor_engagement(
  p_projects uuid[],
  p_since date
)
returns table (project_id uuid, visitors bigint, engaged bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select s.project_id,
         count(*)::bigint as visitors,
         count(*) filter (where s.engaged)::bigint as engaged
  from public.tracker_visitor_daily_stats s
  where s.project_id = any(p_projects)
    and s.day >= p_since
    and s.kind = 'human'
  group by s.project_id;
$$;

grant execute on function public.tracker_visitor_engagement(uuid[], date) to authenticated, service_role;
