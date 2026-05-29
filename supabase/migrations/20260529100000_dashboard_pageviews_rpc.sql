-- Server-side aggregator for the dashboard "past 7 days pageviews"
-- column. The previous client-side approach selected raw rows from
-- tracker_event_daily_stats and summed them in JS — which hit
-- PostgREST's 1000-row cap and silently truncated whichever projects'
-- rows fell off the end (high-traffic projects like ugig.net could
-- eat the entire budget themselves).
--
-- Returns one row per (project, day) so the dashboard can drop it
-- into its existing per-project sparkline buffer.

create or replace function public.dashboard_project_pageviews(
  p_project_ids uuid[],
  p_since date
)
returns table(project_id uuid, day date, count bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select project_id, day, sum(count)::bigint as count
  from public.tracker_event_daily_stats
  where project_id = any(p_project_ids)
    and event = 'pageview'
    and day >= p_since
  group by project_id, day
  order by project_id, day;
$$;

grant execute on function public.dashboard_project_pageviews(uuid[], date) to authenticated;
