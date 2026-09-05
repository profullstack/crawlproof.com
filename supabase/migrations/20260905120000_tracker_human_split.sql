-- Human / bot split for every tracker aggregate the dashboards lead with.
--
-- WHY: the headline numbers on /dashboard, /dashboard/analytics and the
-- per-project stats page were bot-inclusive. On one property 99% of ~257k
-- weekly hits were a single AI training crawler, and the card read as
-- "80k pageviews a day" when the site had a few hundred real readers. The
-- pages need to lead with people and show crawler traffic as a separate
-- figure, which means every RPC they read has to report both.
--
-- DEFINITION (used everywhere, in SQL and in lib/tracker): a row is a HUMAN
-- when its bucket does NOT start with 'bot:'. That includes 'ai_referral:*'
-- (a person arriving from ChatGPT / Perplexity is a person), 'search:*',
-- 'social:*', 'referral:*' and 'human:direct'. A row is a BOT when its bucket
-- starts with 'bot:' (named AI crawlers plus the 'bot:other' catch-all from
-- lib/tracker/categorize.ts). So humans + bots = events, exactly.
--
-- tracker_daily_stats(project_id, day, bucket, count) is the only rollup
-- that records bot-ness; tracker_event_daily_stats has no bucket column, so
-- its pageview / interaction legs stay bot-inclusive and are left as they
-- were. The new columns come from the bucket leg only.
--
-- Return types change here, and `create or replace` cannot change a
-- function's OUT columns, so each one is dropped and re-created. Argument
-- signatures are identical and columns are only ADDED (at the end), so
-- every existing caller keeps reading the fields it already names.
-- Dropping a function drops its grants, hence the re-grants below.
--
-- NOT touched, on purpose: tracker_top_pages_multi, tracker_top_actions_multi
-- and tracker_top_exit_pages_multi carry `set work_mem to '16MB'` from the
-- applied tracker_reporting_indexes migration; re-creating them from an older
-- body would silently drop that setting.
--
-- security invoker throughout, matching every other tracker_* RPC: RLS on the
-- tracker_* tables already scopes SELECT to the project owner / members.
-- Apply one file at a time via the Supabase MCP, not `db push`.

-- ---------------------------------------------------------------------------
-- /dashboard cards: per (project, day) humans and bots for the past-7-days
-- headline and sparkline. dashboard_project_pageviews stays in place; this is
-- the bucket-aware sibling that the cards now read instead.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_project_traffic(
  p_project_ids uuid[],
  p_since date
)
returns table(project_id uuid, day date, humans bigint, bots bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id,
         day,
         coalesce(sum(count) filter (where bucket not like 'bot:%'), 0)::bigint as humans,
         coalesce(sum(count) filter (where bucket like 'bot:%'), 0)::bigint as bots
  from public.tracker_daily_stats
  where project_id = any(p_project_ids)
    and day >= p_since
  group by project_id, day
  order by project_id, day;
$$;

grant execute on function public.dashboard_project_traffic(uuid[], date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per-project window totals (+ humans, prev_humans).
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_project_totals(uuid[], integer);

create function public.tracker_project_totals(
  p_projects uuid[],
  days integer default 30
)
returns table (
  project_id uuid,
  events bigint,
  ai bigint,
  bots bigint,
  prev_events bigint,
  prev_ai bigint,
  prev_bots bigint,
  humans bigint,
  prev_humans bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  -- The two windows are adjacent and equal-length: prev_end is the day before
  -- cur_start, so every row scanned falls in exactly one of them.
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
         coalesce(sum(s.count) filter (where s.day >= b.cur_start), 0)::bigint as events,
         coalesce(sum(s.count) filter (where s.day >= b.cur_start and s.bucket like 'ai_referral:%'), 0)::bigint as ai,
         coalesce(sum(s.count) filter (where s.day >= b.cur_start and s.bucket like 'bot:%'), 0)::bigint as bots,
         coalesce(sum(s.count) filter (where s.day <= b.prev_end), 0)::bigint as prev_events,
         coalesce(sum(s.count) filter (where s.day <= b.prev_end and s.bucket like 'ai_referral:%'), 0)::bigint as prev_ai,
         coalesce(sum(s.count) filter (where s.day <= b.prev_end and s.bucket like 'bot:%'), 0)::bigint as prev_bots,
         coalesce(sum(s.count) filter (where s.day >= b.cur_start and s.bucket not like 'bot:%'), 0)::bigint as humans,
         coalesce(sum(s.count) filter (where s.day <= b.prev_end and s.bucket not like 'bot:%'), 0)::bigint as prev_humans
  from public.tracker_daily_stats s
  cross join bounds b
  where s.project_id = any(p_projects)
    and s.day >= b.prev_start
  group by s.project_id;
$$;

grant execute on function public.tracker_project_totals(uuid[], integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Single-project daily series (+ humans).
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_daily_series(uuid, integer);

create function public.tracker_daily_series(
  p_project uuid,
  days integer default 30
)
returns table (
  day date,
  pageviews bigint,
  interactions bigint,
  ai bigint,
  bots bigint,
  events bigint,
  humans bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with since as (
    select ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1)) as d
  ),
  ev as (
    select day,
           sum(count) filter (where event = 'pageview')::bigint as pageviews,
           sum(count) filter (where event <> 'pageview')::bigint as interactions
    from public.tracker_event_daily_stats
    where project_id = p_project and day >= (select d from since)
    group by day
  ),
  bk as (
    select day,
           sum(count) filter (where bucket like 'ai_referral:%')::bigint as ai,
           sum(count) filter (where bucket like 'bot:%')::bigint as bots,
           sum(count)::bigint as events,
           sum(count) filter (where bucket not like 'bot:%')::bigint as humans
    from public.tracker_daily_stats
    where project_id = p_project and day >= (select d from since)
    group by day
  )
  select coalesce(ev.day, bk.day) as day,
         coalesce(ev.pageviews, 0) as pageviews,
         coalesce(ev.interactions, 0) as interactions,
         coalesce(bk.ai, 0) as ai,
         coalesce(bk.bots, 0) as bots,
         coalesce(bk.events, 0) as events,
         coalesce(bk.humans, 0) as humans
  from ev
  full outer join bk on ev.day = bk.day;
$$;

grant execute on function public.tracker_daily_series(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Portfolio daily series (+ humans).
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_daily_series_multi(uuid[], integer);

create function public.tracker_daily_series_multi(
  p_projects uuid[],
  days integer default 30
)
returns table (
  day date,
  pageviews bigint,
  interactions bigint,
  ai bigint,
  bots bigint,
  events bigint,
  humans bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with since as (
    select ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1)) as d
  ),
  ev as (
    select day,
           sum(count) filter (where event = 'pageview')::bigint as pageviews,
           sum(count) filter (where event <> 'pageview')::bigint as interactions
    from public.tracker_event_daily_stats
    where project_id = any(p_projects) and day >= (select d from since)
    group by day
  ),
  bk as (
    select day,
           sum(count) filter (where bucket like 'ai_referral:%')::bigint as ai,
           sum(count) filter (where bucket like 'bot:%')::bigint as bots,
           sum(count)::bigint as events,
           sum(count) filter (where bucket not like 'bot:%')::bigint as humans
    from public.tracker_daily_stats
    where project_id = any(p_projects) and day >= (select d from since)
    group by day
  )
  select coalesce(ev.day, bk.day) as day,
         coalesce(ev.pageviews, 0) as pageviews,
         coalesce(ev.interactions, 0) as interactions,
         coalesce(bk.ai, 0) as ai,
         coalesce(bk.bots, 0) as bots,
         coalesce(bk.events, 0) as events,
         coalesce(bk.humans, 0) as humans
  from ev
  full outer join bk on ev.day = bk.day;
$$;

grant execute on function public.tracker_daily_series_multi(uuid[], integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per-project daily counts for the stacked portfolio chart (+ humans, bots).
-- Still projects x days rows; callers keep passing a narrowed id list.
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_project_daily_series(uuid[], integer);

create function public.tracker_project_daily_series(
  p_projects uuid[],
  days integer default 30
)
returns table (project_id uuid, day date, events bigint, humans bigint, bots bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id,
         day,
         sum(count)::bigint as events,
         coalesce(sum(count) filter (where bucket not like 'bot:%'), 0)::bigint as humans,
         coalesce(sum(count) filter (where bucket like 'bot:%'), 0)::bigint as bots
  from public.tracker_daily_stats
  where project_id = any(p_projects)
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by project_id, day;
$$;

grant execute on function public.tracker_project_daily_series(uuid[], integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Sub-day series from the raw event table (+ humans).
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_recent_series(uuid, integer, integer);

create function public.tracker_recent_series(
  p_project uuid,
  p_minutes integer default 60,
  p_bucket_seconds integer default 300
)
returns table (
  ts timestamptz,
  pageviews bigint,
  interactions bigint,
  ai bigint,
  bots bigint,
  events bigint,
  humans bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with args as (
    select least(greatest(coalesce(p_minutes, 60), 1), 1440) as mins,
           least(greatest(coalesce(p_bucket_seconds, 300), 60), 86400) as secs
  )
  select to_timestamp(
           floor(extract(epoch from e.occurred_at) / (select secs from args))
           * (select secs from args)
         ) as ts,
         count(*) filter (where e.event = 'pageview')::bigint as pageviews,
         count(*) filter (where e.event <> 'pageview')::bigint as interactions,
         count(*) filter (where e.bucket like 'ai_referral:%')::bigint as ai,
         count(*) filter (where e.bucket like 'bot:%')::bigint as bots,
         count(*)::bigint as events,
         count(*) filter (where coalesce(e.bucket, '') not like 'bot:%')::bigint as humans
  from public.tracker_events e
  where e.project_id = p_project
    and e.occurred_at >= now() - ((select mins from args) || ' minutes')::interval
  group by 1
  order by 1;
$$;

grant execute on function public.tracker_recent_series(uuid, integer, integer) to authenticated, service_role;
