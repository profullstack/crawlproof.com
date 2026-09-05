-- Human / bot split for every tracker breakdown, not just the headline.
--
-- WHY: 20260905120000_tracker_human_split gave the headline tiles and the
-- series chart a human figure, but it could only do that from
-- tracker_daily_stats, the one rollup that records a bucket. Top pages,
-- referrers, actions, exit pages, countries, cities and devices all read
-- rollups that have no idea whether the hit was a person or a crawler, so a
-- reader who narrows the page to Humans still saw a Top pages list that was
-- 99% GPTBot. The stats page now carries a page-wide Humans / Bots / All
-- toggle, and for it to mean the same thing on every card each rollup has
-- to record which side of the line it counted.
--
-- WHAT: a `kind` column on the four bucket-less rollups --
-- tracker_event_daily_stats, tracker_device_daily_stats,
-- tracker_geo_daily_stats, tracker_exit_daily_stats -- plus
-- tracker_exit_sessions, so the exit marker moves within one kind. `kind` is
-- 'human' or 'bot' by the same definition as everywhere else (see
-- lib/tracker/humans.ts: bot = bucket starts with 'bot:', human = anything
-- else, AI referrals included), and joins each table's primary key so a
-- human and a bot hit on the same path in the same day are two rows.
--
-- ROWS BEFORE THIS MIGRATION ARE `unknown`. Nothing in the old rollups can
-- say what they were, so they are not guessed at: they carry kind = 'unknown'
-- and appear only under All (p_kind null). Under Humans or Bots the panels
-- read from these four tables begin on the day this is applied; the UI says
-- so under the toggle. The bucket-based figures (headline tiles, the series
-- chart, Top sources) and the raw tracker_events table have always recorded
-- the bucket, so those are split across all history.
--
-- RPCs: every panel function -- singles, _multi and the tracker_recent_* raw
-- twins -- gains a trailing `p_kind text default null`. null = all rows;
-- 'human' / 'bot' filter on `kind` for the rollups above and on the bucket
-- prefix for tracker_daily_stats and tracker_events. Adding a defaulted
-- parameter changes the signature, so each is dropped by its exact old
-- signature and re-created with the old arguments first; callers that never
-- pass p_kind keep working unchanged. Dropping a function drops its grants,
-- hence the re-grants.
--
-- work_mem: tracker_top_pages_multi, tracker_top_actions_multi and
-- tracker_top_exit_pages_multi carry `set work_mem = '16MB'` from the applied
-- tracker_reporting_indexes migration (their HashAggregate spilled at the
-- 3.5MB instance default). Re-created here WITH that setting; it is
-- per-function on purpose, because /dashboard/analytics fires eleven of these
-- concurrently.
--
-- Indexes: the two covering indexes from 20260902120000 gain `kind` in their
-- INCLUDE list so the filtered aggregates stay index-only. `page_path` stays
-- in the include -- without it tracker_top_pages_multi heap-fetches every
-- matching row (measured at 111k buffers). New names, then drop the old, so
-- coverage never lapses.
--
-- LOCKING: swapping a primary key rebuilds its index under an ACCESS
-- EXCLUSIVE lock. tracker_event_daily_stats is ~1.2M rows / 326MB, so expect
-- ingest writes to queue for the seconds the build takes. The check
-- constraints are added NOT VALID and validated separately so they never
-- take more than SHARE UPDATE EXCLUSIVE.
--
-- security invoker throughout, matching every other tracker_* RPC: these take
-- project ids straight from the caller and rely on RLS. Never definer.
-- Idempotent. Apply one file at a time via the Supabase MCP, not `db push`.

-- ---------------------------------------------------------------------------
-- 1. `kind` column + check on each bucket-less rollup and the exit sessions.
-- ---------------------------------------------------------------------------
alter table public.tracker_event_daily_stats
  add column if not exists kind text not null default 'unknown';
alter table public.tracker_device_daily_stats
  add column if not exists kind text not null default 'unknown';
alter table public.tracker_geo_daily_stats
  add column if not exists kind text not null default 'unknown';
alter table public.tracker_exit_daily_stats
  add column if not exists kind text not null default 'unknown';
alter table public.tracker_exit_sessions
  add column if not exists kind text not null default 'unknown';

do $$
declare
  t text;
begin
  foreach t in array array[
    'tracker_event_daily_stats',
    'tracker_device_daily_stats',
    'tracker_geo_daily_stats',
    'tracker_exit_daily_stats',
    'tracker_exit_sessions'
  ] loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = ('public.' || t)::regclass
        and conname = t || '_kind_check'
    ) then
      execute format(
        'alter table public.%I add constraint %I check (kind in (''human'', ''bot'', ''unknown'')) not valid',
        t, t || '_kind_check'
      );
      execute format('alter table public.%I validate constraint %I', t, t || '_kind_check');
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. `kind` joins each primary key. The ingest route reads and writes these
--    rows by the full key (select ... eq(each column) then insert/update), so
--    the key is the conflict target. Guarded on whether the current PK already
--    names `kind`, so a replay is a no-op rather than a second rebuild.
-- ---------------------------------------------------------------------------
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('tracker_event_daily_stats',
       'project_id, day, event, page_path, referrer_host, event_target, kind'),
      ('tracker_device_daily_stats',
       'project_id, day, device_type, browser, os, kind'),
      ('tracker_geo_daily_stats',
       'project_id, day, country_code, region_code, city, timezone, kind'),
      ('tracker_exit_daily_stats',
       'project_id, day, page_path, kind')
    ) as v(tbl, cols)
  loop
    if not exists (
      select 1
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.conrelid = ('public.' || spec.tbl)::regclass
        and c.contype = 'p'
        and a.attname = 'kind'
    ) then
      execute format('alter table public.%I drop constraint if exists %I', spec.tbl, spec.tbl || '_pkey');
      execute format('alter table public.%I add constraint %I primary key (%s)', spec.tbl, spec.tbl || '_pkey', spec.cols);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Covering indexes: same keys, `kind` added to INCLUDE, page_path kept.
-- ---------------------------------------------------------------------------
create index if not exists tracker_event_daily_stats_project_event_day_kind_idx
  on public.tracker_event_daily_stats (project_id, event, day desc)
  include (page_path, count, kind);

create index if not exists tracker_event_daily_stats_project_day_kind_cover_idx
  on public.tracker_event_daily_stats (project_id, day desc)
  include (event, page_path, referrer_host, event_target, count, kind);

drop index if exists public.tracker_event_daily_stats_project_event_day_idx;
drop index if exists public.tracker_event_daily_stats_project_day_cover_idx;

-- ---------------------------------------------------------------------------
-- 4. Single-project RPCs (+ p_kind).
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_daily_series(uuid, integer);

create function public.tracker_daily_series(
  p_project uuid,
  days integer default 30,
  p_kind text default null
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
    where project_id = p_project
      and day >= (select d from since)
      and (p_kind is null or kind = p_kind)
    group by day
  ),
  bk as (
    select day,
           sum(count) filter (where bucket like 'ai_referral:%')::bigint as ai,
           sum(count) filter (where bucket like 'bot:%')::bigint as bots,
           sum(count)::bigint as events,
           sum(count) filter (where bucket not like 'bot:%')::bigint as humans
    from public.tracker_daily_stats
    where project_id = p_project
      and day >= (select d from since)
      and (p_kind is null
           or (p_kind = 'bot' and bucket like 'bot:%')
           or (p_kind = 'human' and bucket not like 'bot:%'))
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

drop function if exists public.tracker_bucket_totals(uuid, integer, integer);

create function public.tracker_bucket_totals(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and bucket not like 'bot:%'))
  group by bucket
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_event_mix(uuid, integer);

create function public.tracker_event_mix(
  p_project uuid,
  days integer default 30,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by event
  order by total desc;
$$;

drop function if exists public.tracker_top_pages(uuid, integer, integer);

create function public.tracker_top_pages(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by 1
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_referrers(uuid, integer, integer);

create function public.tracker_top_referrers(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by referrer_host
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_actions(uuid, integer, integer);

create function public.tracker_top_actions(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_exit_pages(uuid, integer, integer);

create function public.tracker_top_exit_pages(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by 1
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_countries(uuid, integer, integer);

create function public.tracker_top_countries(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by country_code
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_cities(uuid, integer, integer);

create function public.tracker_top_cities(
  p_project uuid,
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by city, region_code, region_name, country_code, country_name
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_device_totals(uuid, integer);

create function public.tracker_device_totals(
  p_project uuid,
  days integer default 30,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by device_type, browser, os;
$$;

grant execute on function public.tracker_daily_series(uuid, integer, text) to authenticated, service_role;
grant execute on function public.tracker_bucket_totals(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_event_mix(uuid, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_pages(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_referrers(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_actions(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_exit_pages(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_countries(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_cities(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_device_totals(uuid, integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Portfolio (_multi) RPCs (+ p_kind). work_mem kept on the three that
--    spill.
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_daily_series_multi(uuid[], integer);

create function public.tracker_daily_series_multi(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
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
    where project_id = any(p_projects)
      and day >= (select d from since)
      and (p_kind is null or kind = p_kind)
    group by day
  ),
  bk as (
    select day,
           sum(count) filter (where bucket like 'ai_referral:%')::bigint as ai,
           sum(count) filter (where bucket like 'bot:%')::bigint as bots,
           sum(count)::bigint as events,
           sum(count) filter (where bucket not like 'bot:%')::bigint as humans
    from public.tracker_daily_stats
    where project_id = any(p_projects)
      and day >= (select d from since)
      and (p_kind is null
           or (p_kind = 'bot' and bucket like 'bot:%')
           or (p_kind = 'human' and bucket not like 'bot:%'))
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

drop function if exists public.tracker_bucket_totals_multi(uuid[], integer, integer);

create function public.tracker_bucket_totals_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and bucket not like 'bot:%'))
  group by bucket
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_event_mix_multi(uuid[], integer);

create function public.tracker_event_mix_multi(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by event
  order by total desc;
$$;

drop function if exists public.tracker_top_pages_multi(uuid[], integer, integer);

create function public.tracker_top_pages_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
)
returns table (project_id uuid, page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
set work_mem = '16MB'
as $$
  select project_id,
         coalesce(nullif(page_path, ''), '/') as page_path,
         sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and event = 'pageview'
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
    and (p_kind is null or kind = p_kind)
  group by project_id, 2
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_exit_pages_multi(uuid[], integer, integer);

create function public.tracker_top_exit_pages_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
)
returns table (project_id uuid, page_path text, total bigint)
language sql
stable
security invoker
set search_path = public
set work_mem = '16MB'
as $$
  select project_id,
         coalesce(nullif(page_path, ''), '/') as page_path,
         sum(count)::bigint as total
  from public.tracker_exit_daily_stats
  where project_id = any(p_projects)
    and count > 0
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
    and (p_kind is null or kind = p_kind)
  group by project_id, 2
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_referrers_multi(uuid[], integer, integer);

create function public.tracker_top_referrers_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by referrer_host
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_actions_multi(uuid[], integer, integer);

create function public.tracker_top_actions_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
)
returns table (project_id uuid, event text, event_target text, total bigint)
language sql
stable
security invoker
set search_path = public
set work_mem = '16MB'
as $$
  select project_id, event, event_target, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and event <> 'pageview'
    and coalesce(event_target, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
    and (p_kind is null or kind = p_kind)
  group by project_id, event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_countries_multi(uuid[], integer, integer);

create function public.tracker_top_countries_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by country_code
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_top_cities_multi(uuid[], integer, integer);

create function public.tracker_top_cities_multi(
  p_projects uuid[],
  days integer default 30,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by city, region_code, region_name, country_code, country_name
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_device_totals_multi(uuid[], integer);

create function public.tracker_device_totals_multi(
  p_projects uuid[],
  days integer default 30,
  p_kind text default null
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
    and (p_kind is null or kind = p_kind)
  group by device_type, browser, os;
$$;

grant execute on function public.tracker_daily_series_multi(uuid[], integer, text) to authenticated, service_role;
grant execute on function public.tracker_bucket_totals_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_event_mix_multi(uuid[], integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_pages_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_exit_pages_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_referrers_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_actions_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_countries_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_top_cities_multi(uuid[], integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_device_totals_multi(uuid[], integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Raw tracker_events twins (+ p_kind on the bucket prefix). The raw row
--    has always carried its bucket, so these are split across the whole 24h
--    window from the moment this is applied.
-- ---------------------------------------------------------------------------
drop function if exists public.tracker_recent_series(uuid, integer, integer);

create function public.tracker_recent_series(
  p_project uuid,
  p_minutes integer default 60,
  p_bucket_seconds integer default 300,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and e.bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(e.bucket, '') not like 'bot:%'))
  group by 1
  order by 1;
$$;

drop function if exists public.tracker_recent_bucket_totals(uuid, integer, integer);

create function public.tracker_recent_bucket_totals(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and bucket not like 'bot:%'))
  group by bucket
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_recent_event_mix(uuid, integer);

create function public.tracker_recent_event_mix(
  p_project uuid,
  p_minutes integer default 60,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(bucket, '') not like 'bot:%'))
  group by event
  order by total desc;
$$;

drop function if exists public.tracker_recent_top_pages(uuid, integer, integer);

create function public.tracker_recent_top_pages(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(bucket, '') not like 'bot:%'))
  group by 1
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_recent_top_referrers(uuid, integer, integer);

create function public.tracker_recent_top_referrers(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(bucket, '') not like 'bot:%'))
  group by referrer_host
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_recent_top_actions(uuid, integer, integer);

create function public.tracker_recent_top_actions(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(bucket, '') not like 'bot:%'))
  group by event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_recent_top_countries(uuid, integer, integer);

create function public.tracker_recent_top_countries(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(bucket, '') not like 'bot:%'))
  group by country_code
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

drop function if exists public.tracker_recent_top_cities(uuid, integer, integer);

create function public.tracker_recent_top_cities(
  p_project uuid,
  p_minutes integer default 60,
  lim integer default 10,
  p_kind text default null
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
    and (p_kind is null
         or (p_kind = 'bot' and bucket like 'bot:%')
         or (p_kind = 'human' and coalesce(bucket, '') not like 'bot:%'))
  group by city
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$$;

grant execute on function public.tracker_recent_series(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_bucket_totals(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_event_mix(uuid, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_top_pages(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_top_referrers(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_top_actions(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_top_countries(uuid, integer, integer, text) to authenticated, service_role;
grant execute on function public.tracker_recent_top_cities(uuid, integer, integer, text) to authenticated, service_role;
