-- Ad network: mark repeat impressions so machine-driven prefetch stops reading
-- as advertiser delivery.
--
-- Impressions are metered server-side in serveAd at *fill* time, on all three
-- serving paths (/api/ads/serve, /api/ads/frame, /api/ads/motd). Nothing about
-- that requires a browser, and the terminal path deliberately treats curl as a
-- real client. A scheduled pool refresher that fetches one slot N times back to
-- back therefore books N impressions per run, every run, whether or not a human
-- ever loads the page those fills land on. The observed case fires 12 fetches
-- in ~3 seconds every 10 minutes: ~1,700 impressions/day from one machine.
--
-- Clicks already had a dedupe window (lib/ads/fraud.ts); impressions had none
-- at all. This closes that, with two deliberate differences from the click
-- rules, both explained in fraud.ts:
--
--   * keyed on the SLOT, not the campaign — each fetch in a burst draws a
--     different campaign at random, so campaign-keyed dedupe collapses nothing;
--   * 60 seconds, not 6 hours — a repeat view hours later is real delivery and
--     must keep counting.
--
-- Flag rather than drop. The row is what /a/<short_code> resolves a terminal
-- click back to, so skipping the insert would hand a real advertiser's creative
-- a click link pointing at nothing: unbilled click, unpaid publisher. Strictly
-- worse than an inflated count. Reporting excludes flagged rows instead.
--
-- Existing rows default to false, so no historical figure moves.
--
-- Apply via psql over the pooler / MCP (prod history diverged), not `db push`.

alter table public.ad_impressions
  add column if not exists duplicate boolean not null default false;

comment on column public.ad_impressions.duplicate is
  'True when this viewer was already counted on this slot within the impression dedupe window. The row still exists for click attribution; reporting excludes it.';

-- Serves the dedupe lookup itself: (slot, ts) filtered, then visitor/ip matched.
create index if not exists ad_impressions_slot_ts_idx
  on public.ad_impressions (slot_id, ts desc);

-- Reporting: exclude flagged rows from both series functions.
-- Bodies are otherwise unchanged from 20260731140000_ad_range_series.sql.

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
$$;

grant execute on function public.ad_account_series(timestamptz, integer) to authenticated, service_role;

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
$$;

grant execute on function public.ad_campaign_totals(timestamptz) to authenticated, service_role;

-- The dashboard reads impressions through three more surfaces. All of them get
-- the same exclusion, or the spike simply reappears on a different screen.

-- Per-campaign / per-slot totals. Column lists are unchanged, so `create or
-- replace view` is enough here (the free-tier migration had to drop first only
-- because it inserted columns mid-list).
create or replace view public.ad_campaign_stats
  with (security_invoker = true) as
select
  c.id as campaign_id,
  (select count(*) from public.ad_impressions i
     where i.campaign_id = c.id and i.tier = 'paid' and not i.duplicate) as impressions,
  (select count(*) from public.ad_impressions i
     where i.campaign_id = c.id and i.tier = 'free' and not i.duplicate) as free_impressions,
  (select count(*) from public.ad_clicks cl
     where cl.campaign_id = c.id and cl.valid) as clicks,
  (select count(*) from public.ad_clicks cl
     where cl.campaign_id = c.id and not cl.valid and cl.tier = 'free') as free_clicks,
  (select coalesce(sum(cl.charged_cents), 0)
     from public.ad_clicks cl where cl.campaign_id = c.id and cl.valid) as spent_cents,
  c.spend_today_cents,
  c.total_spent_cents
from public.ad_campaigns c;

grant select on public.ad_campaign_stats to authenticated, service_role;

create or replace view public.ad_slot_stats
  with (security_invoker = true) as
select
  s.id as slot_id,
  (select count(*) from public.ad_impressions i
     where i.slot_id = s.id and i.tier = 'paid' and not i.duplicate) as impressions,
  (select count(*) from public.ad_impressions i
     where i.slot_id = s.id and i.tier = 'free' and not i.duplicate) as free_impressions,
  (select count(*) from public.ad_clicks cl
     where cl.slot_id = s.id and cl.valid) as clicks,
  (select count(*) from public.ad_clicks cl
     where cl.slot_id = s.id and not cl.valid and cl.tier = 'free') as free_clicks,
  (select coalesce(sum(cl.publisher_earn_cents), 0)
     from public.ad_clicks cl where cl.slot_id = s.id and cl.valid) as earned_cents
from public.ad_slots s;

grant select on public.ad_slot_stats to authenticated, service_role;

-- Daily series. Body otherwise unchanged from
-- 20260717032002_ad_campaign_daily_series_rpc.sql.
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
$$;

grant execute on function public.ad_campaign_daily_series(integer) to authenticated, service_role;
