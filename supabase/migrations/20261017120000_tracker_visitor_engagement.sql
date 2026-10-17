-- Human visitors and ENGAGED human visitors per project, for the nightly digest.
--
-- WHY: the digest summed tracker_daily_stats, i.e. every beacon stats.js fires
-- (pageview, scroll_*, *_click ...), and called it "human visits". On
-- 2026-10-17 it read 105,786 while the fleet had ~55k human visitor ids, and
-- 99.9% of nichedb.dev's ~37k were one-beacon visitors minted by a rotating
-- headless swarm (fresh browser context per page, 313k IPs in 4 hours).
-- A person who reads a page scrolls or clicks; a scraper that loads it and
-- leaves fires one pageview. So "engaged" = a human visitor with at least two
-- beacons that day. Same rollup as tracker_visitor_totals
-- (20260921120000_tracker_visitor_rollup.sql), same security invoker rule.

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
         count(*) filter (where s.events >= 2)::bigint as engaged
  from public.tracker_visitor_daily_stats s
  where s.project_id = any(p_projects)
    and s.day >= p_since
    and s.kind = 'human'
  group by s.project_id;
$$;

grant execute on function public.tracker_visitor_engagement(uuid[], date) to authenticated, service_role;
