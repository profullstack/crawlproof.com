-- Sub-day aggregates for the per-graph timeframe tabs on /projects/:id/stats.
--
-- WHY: every existing tracker_* RPC reads a *_daily_stats rollup, so the
-- finest window they can express is one UTC calendar day. The stats page needs
-- 1h / 4h / 24h tabs, and the only place that resolution exists is
-- public.tracker_events, which /api/track writes a row-per-event into and
-- prunes at 24h. These functions are the raw-table twins of the daily RPCs:
-- same result shapes, same top-N truncation, windowed by minutes instead of
-- days so the API route can swap one for the other by range key alone.
--
-- Anything older than 24h is not in tracker_events at all, so the 1w / 1m /
-- 1y / all tabs stay on the daily RPCs. p_minutes is clamped to 1440 here to
-- make that boundary explicit rather than silently returning a short window.
--
-- security invoker, matching 20260724120000_tracker_stats_rpc.sql: RLS on
-- tracker_events already scopes SELECT to project members and the owner, so
-- the caller inherits exactly that access.
--
-- Apply one file at a time via the Supabase MCP, not `db push` — prod
-- migration history has diverged from this directory.

-- Per-bucket series for the 4 Traffic pulse lines. p_bucket_seconds sets the
-- resolution (300 = 5min for the 1h tab, 900 for 4h, 3600 for 24h); floor-to-
-- epoch keeps buckets aligned to the wall clock rather than to `now()`.
create or replace function public.tracker_recent_series(
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
  events bigint
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
         count(*)::bigint as events
  from public.tracker_events e
  where e.project_id = p_project
    and e.occurred_at >= now() - ((select mins from args) || ' minutes')::interval
  group by 1
  order by 1;
$$;

-- Top source buckets (Top sources breakdown).
create or replace function public.tracker_recent_bucket_totals(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10
)
returns table (bucket text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select bucket, count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and coalesce(bucket, '') <> ''
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by bucket
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Event mix.
create or replace function public.tracker_recent_event_mix(
  p_project uuid,
  p_minutes integer default 60
)
returns table (event text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select event, count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by event
  order by total desc;
$$;

-- Top pageview paths. This is the one that answers "did /login calm down after
-- we throttled it" at the resolution where the answer is still moving.
create or replace function public.tracker_recent_top_pages(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10
)
returns table (page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(nullif(page_path, ''), '/') as page_path, count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and event = 'pageview'
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by 1
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top external referrer hosts.
create or replace function public.tracker_recent_top_referrers(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10
)
returns table (referrer_host text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select referrer_host, count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and coalesce(referrer_host, '') <> ''
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by referrer_host
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top interactions (non-pageview events carrying a target label).
create or replace function public.tracker_recent_top_actions(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10
)
returns table (event text, event_target text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select event, event_target, count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and event <> 'pageview'
    and coalesce(event_target, '') <> ''
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top countries. tracker_events carries no region/timezone, so the recent
-- twin of tracker_top_countries returns the two columns the page reads.
create or replace function public.tracker_recent_top_countries(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10
)
returns table (country_code text, country_name text, total bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select country_code, max(country_name) as country_name, count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and coalesce(country_code, '') <> ''
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by country_code
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Top cities. region_code / region_name come back empty because the raw table
-- does not store them; the page already tolerates blank segments in the label.
create or replace function public.tracker_recent_top_cities(
  p_project uuid,
  p_minutes integer default 60,
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
  select city,
         ''::text as region_code,
         ''::text as region_name,
         max(country_code) as country_code,
         max(country_name) as country_name,
         count(*)::bigint as total
  from public.tracker_events
  where project_id = p_project
    and coalesce(city, '') <> ''
    and occurred_at >= now()
      - (least(greatest(coalesce(p_minutes, 60), 1), 1440) || ' minutes')::interval
  group by city
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

-- Earliest rollup day, so the "All time" tab can size its axis instead of
-- zero-filling from an arbitrary epoch. Null means the project has no rollups.
create or replace function public.tracker_first_day(p_project uuid)
returns date
language sql
stable
security invoker
set search_path = public
as $$
  select least(
    (select min(day) from public.tracker_daily_stats where project_id = p_project),
    (select min(day) from public.tracker_event_daily_stats where project_id = p_project)
  );
$$;

grant execute on function public.tracker_recent_series(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_bucket_totals(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_event_mix(uuid, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_top_pages(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_top_referrers(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_top_actions(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_top_countries(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_recent_top_cities(uuid, integer, integer) to authenticated, service_role;
grant execute on function public.tracker_first_day(uuid) to authenticated, service_role;
