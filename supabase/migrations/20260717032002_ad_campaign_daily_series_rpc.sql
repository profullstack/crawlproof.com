-- Ad network: per-campaign daily series as a server-side aggregate.
--
-- WHY: the advertiser dashboard sparklines previously fetched raw ad_impressions
-- rows and bucketed them by day in JS. PostgREST caps a single response at 1000
-- rows, so once total impressions in the window exceed 1000 the fetch returns
-- only the first page — a handful of high-volume campaigns consume it and every
-- other campaign gets zero rows back, rendering "no traffic yet" despite having
-- (recent) impressions. Aggregating in Postgres returns at most (campaigns * days)
-- rows, so it never hits the cap and stays cheap.
--
-- security_invoker (SQL functions default to SECURITY INVOKER): RLS on
-- ad_campaigns/ad_impressions/ad_clicks applies to the calling advertiser, and
-- we additionally scope to campaigns they own so slot-based read grants on the
-- publisher side don't leak other advertisers' campaigns into this view.
--
-- Days are UTC calendar days to match the JS axis (dayAxis) in lib/ads/series.ts.
--
-- Apply via psql over the pooler / MCP (prod migration history diverged), not `db push`.

create or replace function public.ad_campaign_daily_series(days integer default 30)
returns table (
  campaign_id uuid,
  day date,
  impressions bigint,
  clicks bigint,
  spent_cents bigint
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
    select id from public.ad_campaigns where owner_id = auth.uid()
  ),
  imps as (
    select i.campaign_id,
           (i.ts at time zone 'UTC')::date as day,
           count(*)::bigint as impressions
    from public.ad_impressions i
    where i.campaign_id in (select id from owned)
      and i.ts >= (select from_ts from since)
    group by 1, 2
  ),
  clk as (
    select cl.campaign_id,
           (cl.ts at time zone 'UTC')::date as day,
           count(*)::bigint as clicks,
           coalesce(sum(cl.charged_cents), 0)::bigint as spent_cents
    from public.ad_clicks cl
    where cl.valid
      and cl.campaign_id in (select id from owned)
      and cl.ts >= (select from_ts from since)
    group by 1, 2
  )
  select coalesce(i.campaign_id, c.campaign_id) as campaign_id,
         coalesce(i.day, c.day) as day,
         coalesce(i.impressions, 0) as impressions,
         coalesce(c.clicks, 0) as clicks,
         coalesce(c.spent_cents, 0) as spent_cents
  from imps i
  full outer join clk c
    on c.campaign_id = i.campaign_id and c.day = i.day;
$$;

grant execute on function public.ad_campaign_daily_series(integer) to authenticated, service_role;
