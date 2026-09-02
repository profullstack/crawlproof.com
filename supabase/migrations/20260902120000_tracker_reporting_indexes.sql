-- Tracker reporting: cover the rollup reads so they stop hitting the timeout.
--
-- The portfolio dashboard read "0 pageviews" on every project while ingest was
-- writing a row a second. Same *shape* as the ad dashboard bug fixed in #226,
-- but NOT the same cause -- worth stating plainly, because the obvious move
-- (flip these to security definer, as #226 did) is both wrong and unsafe here.
--
-- Wrong, because RLS is not what costs: the same query run as `postgres` with
-- no policy in the plan still took 8.4s. Unsafe, because the ad RPCs each
-- authorised themselves (`<x>_id in (select id from owned)`) and these do not
-- -- every tracker_*_multi takes p_projects straight from the caller and leans
-- entirely on RLS to decide what it may read. Made definer as they stand, any
-- authenticated user could pass another account's project ids and read their
-- analytics. If these are ever made definer they must grow an ownership
-- filter of their own first.
--
-- The actual cause is the index. tracker_event_daily_stats_project_event_idx
-- is (project_id, event) with no `day`, so for the dashboard's
-- "project in (...) and event = 'pageview' and day >= X" the planner matched
-- 373,506 index entries, heap-fetched every one to read `day` and `count`, and
-- threw 228,872 of them away on the filter: 152,894 buffers and 9,401ms for a
-- 260-row answer, against the 8s statement_timeout on `authenticated`.
--
-- Measured on prod (ref ywcizjsgrcmhgyplldac, 1.21M rows / 326MB), as the
-- 48-project owner, with RLS on:
--
--   dashboard_project_pageviews   9,401ms / 152,894 buf  ->  115ms / 19,647
--   tracker_top_pages_multi       5,764ms /  77,663 buf  ->  752ms / 22,764
--   tracker_top_actions_multi     1,927ms / 326,441 buf  ->  635ms / 41,379
--   tracker_top_referrers_multi   1,518ms / 328,030 buf  ->  ~1.7s / 41,358
--
-- `page_path` rides in the INCLUDE of the (project_id, event, day) index
-- specifically so tracker_top_pages_multi runs index-only. Without it the
-- planner still picks that index for the event predicate but has to heap-fetch
-- all 373,710 matching rows to read the path -- 111,534 buffers, measured, and
-- worse than before the index existed.
--
-- Both indexes carry `count` in INCLUDE so the aggregates run index-only. That
-- does cost writes: `count` is now an indexed value, so the per-event upsert
-- can no longer take the HOT path. Ingest is ~1-3 events/sec against 1.2M
-- rows, so this is the right side of the trade, but it is the thing to watch
-- if ingest volume grows an order of magnitude.
--
-- These were created CONCURRENTLY on prod on 2026-09-02 (a 326MB table under
-- live ingest); `if not exists` here so replay is a no-op rather than a lock.
--
-- Longer term this is still the rollup problem #226 flagged: these queries
-- aggregate 300k-1.2M rows per page load and indexes only make that cheaper,
-- not small. A pre-aggregated daily table is the next move if it regresses.

create index if not exists tracker_event_daily_stats_project_event_day_idx
  on public.tracker_event_daily_stats (project_id, event, day desc)
  include (page_path, count);

create index if not exists tracker_event_daily_stats_project_day_cover_idx
  on public.tracker_event_daily_stats (project_id, day desc)
  include (event, page_path, referrer_host, event_target, count);

-- Superseded: (project_id, event) is a strict prefix of the new
-- (project_id, event, day desc). Dropped rather than left in place because it
-- is not merely redundant, it is the trap -- it is what the planner kept
-- choosing over the day-bearing indexes.
drop index if exists public.tracker_event_daily_stats_project_event_idx;

-- work_mem is 3.5MB on this instance. The three panels that group by a
-- high-cardinality text column (page_path, event_target) spilled their
-- HashAggregate to disk: tracker_top_pages_multi wrote 4,401 temp blocks and
-- took 5.8s at 365 days, which is inside the 8s ceiling only on a warm cache.
-- Raised per function, not globally, because /dashboard/analytics fires eleven
-- of these concurrently and a session-wide raise multiplies by eleven.
create or replace function public.tracker_top_pages_multi(p_projects uuid[], days integer default 30, lim integer default 10)
 returns table(project_id uuid, page_path text, total bigint)
 language sql
 stable
 set search_path to 'public'
 set work_mem to '16MB'
as $function$
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
$function$;

create or replace function public.tracker_top_actions_multi(p_projects uuid[], days integer default 30, lim integer default 10)
 returns table(project_id uuid, event text, event_target text, total bigint)
 language sql
 stable
 set search_path to 'public'
 set work_mem to '16MB'
as $function$
  select project_id, event, event_target, sum(count)::bigint as total
  from public.tracker_event_daily_stats
  where project_id = any(p_projects)
    and event <> 'pageview'
    and coalesce(event_target, '') <> ''
    and day >= ((now() at time zone 'UTC')::date - (greatest(coalesce(days, 30), 1) - 1))
  group by project_id, event, event_target
  order by total desc
  limit greatest(coalesce(lim, 10), 1);
$function$;

create or replace function public.tracker_top_exit_pages_multi(p_projects uuid[], days integer default 30, lim integer default 10)
 returns table(project_id uuid, page_path text, total bigint)
 language sql
 stable
 set search_path to 'public'
 set work_mem to '16MB'
as $function$
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
$function$;
