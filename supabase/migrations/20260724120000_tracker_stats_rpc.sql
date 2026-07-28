-- Project stats: server-side aggregates for the /projects/:id/stats dashboard.
--
-- WHY: the stats page fetched RAW rollup rows (tracker_event_daily_stats,
-- tracker_daily_stats, tracker_geo/exit/device_daily_stats) and bucketed them
-- in JS. PostgREST caps a single response at 1000 rows, and the fetches order
-- by `day desc` with no limit — so once a project's rollup rows in the window
-- exceed 1000, only the NEWEST ~1000 come back and all older history is
-- silently dropped. High-cardinality tables blow the cap fast (one busy site
-- had 91k event rows / 30d), which is why pageview/interaction lines — and the
-- Top pages / referrers / actions / geo breakdowns computed from the same
-- truncated array — showed "a spike recently, nothing before". Aggregating in
-- Postgres returns at most (days) or (lim) rows, so it never hits the cap.
--
-- security invoker: RLS on every tracker_* table already scopes SELECT to the
-- project owner (and, where present, project members). Calling these with the
-- authenticated user's role means they inherit that exact access — no new
-- surface, no owner logic duplicated here.
--
-- Days are UTC calendar days to match buildDaily()'s axis in the page.
-- Apply via psql over the pooler / MCP (prod migration history diverged),
-- not `db push`.

-- Per-day series for the 4 chart lines (pageviews, interactions, ai, bots)
-- plus the bucket-total "events" used for the header count.
create or replace function public.tracker_daily_series(
  p_project uuid,
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
    where project_id = p_project and day >= (select d from since)
    group by day
  ),
  bk as (
    select day,
           sum(count) filter (where bucket like 'ai_referral:%')::bigint as ai,
           sum(count) filter (where bucket like 'bot:%')::bigint as bots,
           sum(count)::bigint as events
    from public.tracker_daily_stats
    where project_id = p_project and day >= (select d from since)
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

-- Top buckets over the window (drives the Top sources breakdown). Top-N so a
-- project with thousands of distinct referral:<host> buckets can't hit the cap.
-- The AI / bot / other headline metrics are derived from tracker_daily_series
-- in the page (ai_referral vs bot vs everything-else), so they stay exact even
-- though this list is truncated.
create or replace function public.tracker_bucket_totals(
  p_project uuid,
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
  where project_id = p_project
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by bucket
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Event mix over the window (grouped by event name).
create or replace function public.tracker_event_mix(
  p_project uuid,
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
  where project_id = p_project
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by event
  order by total desc;
$$;

-- Top pageview paths.
create or replace function public.tracker_top_pages(
  p_project uuid,
  days integer default 30,
  lim integer default 10
)
returns table (page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(nullif(page_path, ''), '/') as page_path, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = p_project
    and event = 'pageview'
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by 1
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top external referrer hosts (across all events, matching the JS filter).
create or replace function public.tracker_top_referrers(
  p_project uuid,
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
  where project_id = p_project
    and coalesce(referrer_host, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by referrer_host
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top interactions (non-pageview events that carry a target label).
create or replace function public.tracker_top_actions(
  p_project uuid,
  days integer default 30,
  lim integer default 10
)
returns table (event text, event_target text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select event, event_target, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = p_project
    and event <> 'pageview'
    and coalesce(event_target, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top exit pages.
create or replace function public.tracker_top_exit_pages(
  p_project uuid,
  days integer default 30,
  lim integer default 10
)
returns table (page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(nullif(page_path, ''), '/') as page_path, sum(count)::bigint as total
  from public.tracker_exit_daily_stats
  where project_id = p_project
    and count > 0
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by 1
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top countries.
create or replace function public.tracker_top_countries(
  p_project uuid,
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
  where project_id = p_project
    and (coalesce(country_code, '') <> '' or coalesce(country_name, '') <> '')
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by country_code
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top cities (returns the components; the page builds the display label).
create or replace function public.tracker_top_cities(
  p_project uuid,
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
  where project_id = p_project
    and coalesce(city, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by city, region_code, region_name, country_code, country_name
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Device / browser / OS totals over the window (collapsed over days). Distinct
-- (device_type, browser, os) combos are low-cardinality; the page reshapes this
-- one result into the Devices / Browsers / Operating systems lists.
create or replace function public.tracker_device_totals(
  p_project uuid,
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
  where project_id = p_project
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by device_type, browser, os;
$$;

grant execute on function public.tracker_daily_series(uuid, integer) to authenticated, service_role;
grant execute on function public.tracker_bucket_totals(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_event_mix(uuid, integer) to authenticated, service_role;
grant execute on function public.tracker_top_pages(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_referrers(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_actions(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_exit_pages(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_countries(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_top_cities(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_device_totals(uuid, integer) to authenticated, service_role;
