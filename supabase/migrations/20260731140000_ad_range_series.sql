-- Ad network: arbitrary-window, arbitrary-bucket series for the advertiser
-- dashboard's stock-chart style range picker (1H / 4H / 1D / 1W / 1M / 3M / 1Y / ALL).
--
-- ad_campaign_daily_series only buckets by UTC calendar day, which can't answer
-- "the last hour in 1-minute steps". These two functions take the window and the
-- bucket width as parameters instead.
--
-- Deliberately split in two, because of the PostgREST 1000-row response cap that
-- forced server-side aggregation in the first place (see
-- 20260717032002_ad_campaign_daily_series_rpc.sql):
--
--   * ad_account_series  — account-wide, so the row count is (buckets), never
--     (campaigns × buckets). 34 campaigns over a 90-day daily window would be
--     3,060 rows and would silently truncate; account-wide it's 90.
--   * ad_campaign_totals — per campaign but NOT bucketed, so it's (campaigns)
--     rows. Enough to make the per-campaign list obey the same range without
--     re-introducing the product.
--
-- security invoker (the SQL default) so RLS applies to the caller, plus an
-- explicit owner_id = auth.uid() scope so publisher-side read grants on
-- ad_impressions/ad_clicks can't leak another advertiser's campaigns in.
--
-- Apply via psql over the pooler / MCP (prod history diverged), not `db push`.

-- Account-wide bucketed series. p_since null = all time.
create or replace function public.ad_account_series(
  p_since timestamptz default null,
  p_bucket_seconds integer default 86400
)
returns table (
  bucket timestamptz,
  impressions bigint,
  free_impressions bigint,
  clicks bigint,
  free_clicks bigint,
  spent_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with b as (
    -- Floor at 60s: a sub-minute bucket over a long window would return more
    -- rows than the response cap allows, and no range needs finer than 1m.
    select make_interval(secs => greatest(coalesce(p_bucket_seconds, 86400), 60)) as step
  ),
  owned as (
    select id from public.ad_campaigns where owner_id = auth.uid()
  ),
  ev as (
    select date_bin((select step from b), i.ts, timestamptz 'epoch') as bucket,
           case when i.tier = 'free' then 0 else 1 end as imp,
           case when i.tier = 'free' then 1 else 0 end as free_imp,
           0 as clk,
           0 as free_clk,
           0 as spent
    from public.ad_impressions i
    where i.campaign_id in (select id from owned)
      and (p_since is null or i.ts >= p_since)
    union all
    select date_bin((select step from b), cl.ts, timestamptz 'epoch'),
           0,
           0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then cl.charged_cents else 0 end
    from public.ad_clicks cl
    where cl.campaign_id in (select id from owned)
      and (p_since is null or cl.ts >= p_since)
  )
  select bucket,
         sum(imp)::bigint,
         sum(free_imp)::bigint,
         sum(clk)::bigint,
         sum(free_clk)::bigint,
         sum(spent)::bigint
  from ev
  group by bucket
  order by bucket;
$$;

grant execute on function public.ad_account_series(timestamptz, integer) to authenticated, service_role;

-- Per-campaign totals for the same window — one row per campaign, no buckets.
create or replace function public.ad_campaign_totals(
  p_since timestamptz default null
)
returns table (
  campaign_id uuid,
  impressions bigint,
  free_impressions bigint,
  clicks bigint,
  free_clicks bigint,
  spent_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with owned as (
    select id from public.ad_campaigns where owner_id = auth.uid()
  ),
  ev as (
    select i.campaign_id,
           case when i.tier = 'free' then 0 else 1 end as imp,
           case when i.tier = 'free' then 1 else 0 end as free_imp,
           0 as clk,
           0 as free_clk,
           0 as spent
    from public.ad_impressions i
    where i.campaign_id in (select id from owned)
      and (p_since is null or i.ts >= p_since)
    union all
    select cl.campaign_id,
           0,
           0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then cl.charged_cents else 0 end
    from public.ad_clicks cl
    where cl.campaign_id in (select id from owned)
      and (p_since is null or cl.ts >= p_since)
  )
  select campaign_id,
         sum(imp)::bigint,
         sum(free_imp)::bigint,
         sum(clk)::bigint,
         sum(free_clk)::bigint,
         sum(spent)::bigint
  from ev
  group by campaign_id;
$$;

grant execute on function public.ad_campaign_totals(timestamptz) to authenticated, service_role;
