-- Ad network: per-slot daily PUBLISHER EARNINGS as a server-side aggregate.
--
-- Mirror of ad_campaign_daily_series (advertiser spend) for the publisher side,
-- powering the /ads/earnings page's earnings-over-time chart and PDF report.
-- Same rationale: bucketing raw ad_clicks in JS would hit PostgREST's 1000-row
-- cap once a slot is busy, so aggregate in Postgres (at most slots * days rows).
--
-- security_invoker: RLS on ad_slots/ad_clicks applies to the caller, and we
-- additionally scope to slots they OWN so nothing leaks across accounts.
-- Earnings come from ad_clicks.publisher_earn_cents (floor rate), matching the
-- ad_slot_stats view and the publisher_accrual ledger.
--
-- Days are UTC calendar days to match dayAxis() in lib/ads/series.ts.
-- Apply via psql over the pooler / MCP (prod migration history diverged).

create or replace function public.ad_slot_daily_series(days integer default 30)
returns table (
  slot_id uuid,
  day date,
  clicks bigint,
  earned_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with bounds as (
    select greatest(coalesce(days, 30), 1) as n
  ),
  since as (
    select ((now() at time zone 'UTC')::date - (n - 1))::timestamptz as from_ts
    from bounds
  ),
  owned as (
    select id from public.ad_slots where owner_id = auth.uid()
  )
  select cl.slot_id,
         (cl.ts at time zone 'UTC')::date as day,
         count(*)::bigint as clicks,
         coalesce(sum(cl.publisher_earn_cents), 0)::bigint as earned_cents
  from public.ad_clicks cl
  where cl.valid
    and cl.slot_id in (select id from owned)
    and cl.ts >= (select from_ts from since)
  group by 1, 2;
$$;

grant execute on function public.ad_slot_daily_series(integer) to authenticated, service_role;
