-- Portfolio stats: multi-project variants of the tracker_* aggregates that
-- power /projects/:id/stats, for the global /analytics page.
--
-- WHY: the global page needs the same breakdowns rolled up across every
-- project the viewer can see. Calling the single-project RPCs once per project
-- and merging in JS would be N round trips and would re-truncate every top-N
-- list before merging (a bucket ranked 11th on each of ten sites can easily be
-- the #1 bucket overall, yet would never appear). Aggregating the whole set in
-- one query keeps the ranking correct and the row count bounded.
--
-- security invoker, exactly like the single-project RPCs: RLS on the tracker_*
-- tables already scopes SELECT to the project owner / members, so passing an
-- id the caller can't see contributes nothing rather than leaking.
--
-- Row-cap discipline (PostgREST caps a response at 1000 rows): every function
-- here returns at most (days) rows, (lim) rows, or one row per project. The
-- one exception is tracker_project_daily_series, which is projects x days —
-- see the note on that function.
--
-- Days are UTC calendar days to match the axis the pages build in JS.
-- Apply via psql over the pooler / MCP (prod migration history diverged),
-- not `db push`.

-- Per-day series for the 4 chart lines, summed over every project in the set.
create or replace function public.tracker_daily_series_multi(
  p_projects uuid[],
  days integer default 30
)
returns table (
  day date,
  pageviews bigint,
  interactions bigint,
  ai bigint,
  bots bigint,
  events bigint
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
           sum(count)::bigint as events
    from public.tracker_daily_stats
    where project_id = any(p_projects) and day >= (select d from since)
    group by day
  )
  select coalesce(ev.day, bk.day) as day,
         coalesce(ev.pageviews, 0) as pageviews,
         coalesce(ev.interactions, 0) as interactions,
         coalesce(bk.ai, 0) as ai,
         coalesce(bk.bots, 0) as bots,
         coalesce(bk.events, 0) as events
  from ev
  full outer join bk on ev.day = bk.day;
$$;

-- Per-project totals for the current window AND the window immediately before
-- it, so the page can say whether each property is up, down, or sideways.
-- One row per project that has any traffic in either window.
create or replace function public.tracker_project_totals(
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
  prev_bots bigint
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
         coalesce(sum(s.count) filter (where s.day <= b.prev_end and s.bucket like 'bot:%'), 0)::bigint as prev_bots
  from public.tracker_daily_stats s
  cross join bounds b
  where s.project_id = any(p_projects)
    and s.day >= b.prev_start
  group by s.project_id;
$$;

-- Per-project daily event counts, for the stacked portfolio chart and the
-- per-project sparklines.
--
-- CAUTION: this one returns projects x days rows, so it is the only function
-- here that can approach PostgREST's 1000-row cap. Callers must pass a
-- narrowed id list (the page passes only the handful of projects it charts
-- individually and derives the "Other" band by subtracting them from
-- tracker_daily_series_multi, which stays exact for the full set).
create or replace function public.tracker_project_daily_series(
  p_projects uuid[],
  days integer default 30
)
returns table (project_id uuid, day date, events bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id, day, sum(count)::bigint as events
  from public.tracker_daily_stats
  where project_id = any(p_projects)
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by project_id, day;
$$;

-- Top buckets across the set (drives the Top sources breakdown).
create or replace function public.tracker_bucket_totals_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (bucket text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select bucket, sum(count)::bigint as total
  from public.tracker_daily_stats
  where project_id = any(p_projects)
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by bucket
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Event mix across the set.
create or replace function public.tracker_event_mix_multi(
  p_projects uuid[],
  days integer default 30
)
returns table (event text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select event, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by event
  order by total desc;
$$;

-- Top pageview paths. Grouped by project as well as path: '/' exists on every
-- site, so collapsing across projects would produce a meaningless "/" row. The
-- page labels each entry with the project it belongs to.
create or replace function public.tracker_top_pages_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (project_id uuid, page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id,
         coalesce(nullif(page_path, ''), '/') as page_path,
         sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and event = 'pageview'
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by project_id, 2
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top exit pages, grouped by project for the same reason as top pages.
create or replace function public.tracker_top_exit_pages_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (project_id uuid, page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id,
         coalesce(nullif(page_path, ''), '/') as page_path,
         sum(count)::bigint as total
  from public.tracker_exit_daily_stats
  where project_id = any(p_projects)
    and count > 0
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by project_id, 2
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top external referrer hosts across the set. Referrer hosts are genuinely
-- global (news.ycombinator.com sending to three of your sites is one story),
-- so these collapse across projects.
create or replace function public.tracker_top_referrers_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (referrer_host text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select referrer_host, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and coalesce(referrer_host, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by referrer_host
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top interactions across the set, grouped by project so a generic target
-- label ("signup") stays attributable to the site it fired on.
create or replace function public.tracker_top_actions_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (project_id uuid, event text, event_target text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id, event, event_target, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and event <> 'pageview'
    and coalesce(event_target, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by project_id, event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top countries across the set.
create or replace function public.tracker_top_countries_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (country_code text, country_name text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select country_code, max(country_name) as country_name, sum(count)::bigint as total
  from public.tracker_geo_daily_stats
  where project_id = any(p_projects)
    and (coalesce(country_code, '') <> '' or coalesce(country_name, '') <> '')
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by country_code
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top cities across the set.
create or replace function public.tracker_top_cities_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10
)
returns table (
  city text,
  region_code text,
  region_name text,
  country_code text,
  country_name text,
  total bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select city, region_code, region_name, country_code, country_name,
         sum(count)::bigint as total
  from public.tracker_geo_daily_stats
  where project_id = any(p_projects)
    and coalesce(city, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by city, region_code, region_name, country_code, country_name
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Device / browser / OS totals across the set.
create or replace function public.tracker_device_totals_multi(
  p_projects uuid[],
  days integer default 30
)
returns table (device_type text, browser text, os text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select device_type, browser, os, sum(count)::bigint as total
  from public.tracker_device_daily_stats
  where project_id = any(p_projects)
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by device_type, browser, os;
$$;

grant execute on function public.tracker_daily_series_multi(uuid[], integer) to authenticated, service_role;
grant execute on function public.tracker_project_totals(uuid[], integer) to authenticated, service_role;
grant execute on function public.tracker_project_daily_series(uuid[], integer) to authenticated, service_role;
grant execute on function public.tracker_bucket_totals_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_event_mix_multi(uuid[], integer) to authenticated, service_role;
grant execute on function public.tracker_top_pages_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_exit_pages_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_referrers_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_actions_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_countries_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_cities_multi(uuid[], integer, integer) to authenticated, service_role;
grant execute on function public.tracker_device_totals_multi(uuid[], integer) to authenticated, service_role;
