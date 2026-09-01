-- Ad reporting RPCs: run as definer so RLS stops forcing a nested loop.
--
-- The advertiser dashboard read 0 for everything, intermittently, while the
-- account was delivering 176k impressions over the window. Not a measure bug
-- this time (that was #199 and #225): the RPCs were being CANCELLED.
--
-- These functions are security invoker, so the RLS policy on ad_impressions
-- ("slot is mine OR campaign is mine") joins the plan. With it, the planner
-- abandons the hash join and picks a nested loop -- one index scan per owned
-- campaign, 139 loops, ~176k random heap fetches -- touching 401,791 buffers
-- (~3GB) per page load. Warm that is ~930ms; cold, against the 8s
-- statement_timeout on `authenticated`, it loses. ad_impressions passed 364k
-- rows / 154MB and traffic ran 10x baseline on 2026-09-01 (14,580/hr against
-- ~500/hr), which is what finally tipped it: 34 "canceling statement due to
-- statement timeout" errors in two hours, surfacing as HTTP 500 on
-- ad_account_series, ad_campaign_totals and ad_campaign_daily_series.
--
-- Every caller swallows the error into an empty result (`error ? [] : rows`),
-- so a cancelled query is indistinguishable from no data and the whole page --
-- four tiles, the chart, every campaign row -- reads 0 at once. Measured
-- definer vs invoker on the same input: 11,818 buffers / 208ms against
-- 401,791 / 932ms, a 34x reduction in pages touched, byte-identical output.
--
-- Safe because each function was already doing its own authorisation and never
-- relied on RLS for it: every base-table read is gated by
-- `<x>_id in (select id from owned)`, and `owned` is `owner_id = auth.uid()`.
-- Note it is `in` and not `not in`, so an anon caller (auth.uid() null) gets an
-- empty `owned` and therefore zero rows rather than everything. Verified with a
-- stranger's JWT: 0 rows from all five. search_path is pinned on all five, as
-- definer requires.
--
-- Bodies are otherwise untouched -- this changes only the security mode.
--
-- Apply via psql over the pooler / MCP (prod history diverged), not `db push`.

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
security definer
set search_path to 'public'
as $function$
  with b as (
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
      and not i.duplicate
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
$function$;

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
security definer
set search_path to 'public'
as $function$
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
      and not i.duplicate
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
$function$;

create or replace function public.ad_slot_totals(
  p_since timestamptz default null
)
returns table (
  slot_id uuid,
  impressions bigint,
  free_impressions bigint,
  clicks bigint,
  free_clicks bigint,
  invalid_clicks bigint,
  earned_cents bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with owned as (
    select id from public.ad_slots where owner_id = auth.uid()
  ),
  ev as (
    select i.slot_id,
           case when i.tier = 'free' then 0 else 1 end as imp,
           case when i.tier = 'free' then 1 else 0 end as free_imp,
           0 as clk,
           0 as free_clk,
           0 as invalid_clk,
           0 as earned
    from public.ad_impressions i
    where i.slot_id in (select id from owned)
      and not i.duplicate
      and (p_since is null or i.ts >= p_since)
    union all
    select cl.slot_id,
           0,
           0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when not cl.valid and cl.tier <> 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.publisher_earn_cents, 0) else 0 end
    from public.ad_clicks cl
    where cl.slot_id in (select id from owned)
      and (p_since is null or cl.ts >= p_since)
  )
  select slot_id,
         sum(imp)::bigint,
         sum(free_imp)::bigint,
         sum(clk)::bigint,
         sum(free_clk)::bigint,
         sum(invalid_clk)::bigint,
         sum(earned)::bigint
  from ev
  group by slot_id;
$function$;

create or replace function public.ad_campaign_daily_series(
  days integer default 30
)
returns table (
  campaign_id uuid,
  day date,
  impressions bigint,
  clicks bigint,
  spent_cents bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
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
      and not i.duplicate
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
$function$;

create or replace function public.ad_slot_daily_series(
  days integer default 30
)
returns table (
  slot_id uuid,
  day date,
  clicks bigint,
  earned_cents bigint
)
language sql
stable
security definer
set search_path to 'public'
as $function$
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
$function$;
