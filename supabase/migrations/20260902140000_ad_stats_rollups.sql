-- Pre-aggregate ad delivery so the dashboards stop scanning raw events.
--
-- /dashboard/ads renders no graphs, intermittently. The chart falls back to
-- "No delivery in this range." and every sparkline to "no traffic yet" because
-- ad_account_series and ad_campaign_daily_series are being cancelled by the 8s
-- statement_timeout on `authenticated`. Measured over 24h on 2026-09-02:
-- ad_account_series avg 1,453ms / max 8,039ms, ad_campaign_daily_series avg
-- 1,719ms / max 8,027ms, and 14 of ~150 reporting calls returned HTTP 500.
--
-- This is NOT the RLS nested-loop from 20260901153000 -- that fix held, the
-- plan is a clean hash join. It is simply that every dashboard load aggregates
-- the whole event history from scratch:
--
--   Seq Scan on ad_impressions  (actual rows=177858)
--     Filter: ((NOT duplicate) AND (ts >= now() - '30 days'))
--     Rows Removed by Filter: 198394
--     Buffers: shared hit=9767          -- the entire 78MB heap, every load
--
-- and the page issues three such RPCs per render. ad_impressions is 376k rows
-- growing ~90k/day, so the cost rises with the archive rather than with the
-- window being asked for, and no index fixes that: the 30-day window selects
-- 47% of the table, far past the point an index scan can win. A covering
-- partial index (added below, and it is still worth having -- see the RPCs) was
-- measured at 157ms against 194ms for the seq scan, a 20% gain on a query that
-- needs to be 10x faster.
--
-- So aggregate once, on a schedule, and let a page load read buckets instead of
-- events. The grain is chosen by what each surface actually plots:
--
--   ad_stats_owner_hourly    (owner_id, hour)     ~24 rows/day
--   ad_stats_campaign_daily  (campaign_id, day)   ~135 rows/day
--   ad_stats_slot_daily      (slot_id, day)       ~27 rows/day
--
-- A 30-day account query now reads ~720 rows where it read 246,506.
--
-- Per-campaign is deliberately DAILY and not hourly: (campaign_id, hour) is
-- 2,997 distinct cells in a single day against 139 campaigns, which over the
-- archive is ~170k rows -- barely smaller than the raw table it replaces, so it
-- would buy nothing. Account-wide has no campaign dimension at all, which is
-- what makes hourly affordable there, and hourly is required there because the
-- 1W range plots 4-hour buckets.
--
-- FRESHNESS. Rollup rows are only ever read for periods that have closed; the
-- current hour and the current UTC day are always read from raw. So a stale or
-- even a completely un-run refresh can never show wrong numbers for the live
-- edge, and the raw slices it reads are at most one hour / one day wide, which
-- is where the covering index earns its place.

-- The reporting predicate is always (not duplicate) over a ts window, and the
-- columns wanted are few enough to ride along in the index. This serves the
-- narrow live-edge reads the RPCs below fall back to, and the refresh itself.
create index if not exists ad_impressions_reporting_idx
  on public.ad_impressions (ts) include (campaign_id, slot_id, tier)
  where not duplicate;

create index if not exists ad_clicks_reporting_idx
  on public.ad_clicks (ts) include (campaign_id, slot_id, tier, valid, charged_cents, publisher_earn_cents);

-- ---------------------------------------------------------------------------
-- Rollup tables
-- ---------------------------------------------------------------------------
-- Column names mirror the RPC output they feed, including the split that has
-- caught this codebase out three times: `paid_*` and `free_*` are halves, never
-- totals. Anything reading one without the other is reading a network where
-- every fill is free backfill as though it were dead.

create table if not exists public.ad_stats_owner_hourly (
  owner_id          uuid        not null,
  hour              timestamptz not null,
  paid_impressions  bigint      not null default 0,
  free_impressions  bigint      not null default 0,
  valid_clicks      bigint      not null default 0,
  free_clicks       bigint      not null default 0,
  spent_cents       bigint      not null default 0,
  primary key (owner_id, hour)
);

create table if not exists public.ad_stats_campaign_daily (
  campaign_id       uuid        not null,
  day               date        not null,
  paid_impressions  bigint      not null default 0,
  free_impressions  bigint      not null default 0,
  valid_clicks      bigint      not null default 0,
  free_clicks       bigint      not null default 0,
  spent_cents       bigint      not null default 0,
  primary key (campaign_id, day)
);

create table if not exists public.ad_stats_slot_daily (
  slot_id           uuid        not null,
  day               date        not null,
  paid_impressions  bigint      not null default 0,
  free_impressions  bigint      not null default 0,
  valid_clicks      bigint      not null default 0,
  free_clicks       bigint      not null default 0,
  invalid_clicks    bigint      not null default 0,
  earned_cents      bigint      not null default 0,
  primary key (slot_id, day)
);

-- Read exclusively through the security-definer RPCs below, which do their own
-- ownership filtering. RLS on with no policy is the intended posture: it denies
-- every direct PostgREST read while the definer functions (owned by the
-- migration role) still see the rows.
alter table public.ad_stats_owner_hourly   enable row level security;
alter table public.ad_stats_campaign_daily enable row level security;
alter table public.ad_stats_slot_daily     enable row level security;

revoke all on public.ad_stats_owner_hourly   from anon, authenticated;
revoke all on public.ad_stats_campaign_daily from anon, authenticated;
revoke all on public.ad_stats_slot_daily     from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Refresh
-- ---------------------------------------------------------------------------

/**
 * Recompute every rollup for events at or after p_from and upsert the result.
 *
 * Idempotent, so re-running over a period that is already rolled up is a no-op
 * in effect. Deliberately a full recompute of the touched periods rather than a
 * delta: ad_clicks rows are updated after insert (a click is charged, or later
 * invalidated), so counting only new rows would drift. Recomputing a bounded
 * tail cannot.
 *
 * Periods with no events are simply absent; the RPCs zero-fill their own axis,
 * as they always have.
 */
create or replace function public.ad_stats_rollup_refresh(
  p_from timestamptz default (now() - interval '2 days')
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  -- Snap the window down to whole periods before recomputing. p_from is a plain
  -- "two days ago" from the scheduler, which lands mid-day: filtering raw events
  -- on it directly would recompute 08-31 from 13:40 onwards and then upsert that
  -- partial count over the complete row already stored for that day. Every
  -- period this function touches has to be recomputed in full or not at all.
  v_from_hour timestamptz := date_trunc('hour', p_from);
  v_from_day  timestamptz := date_trunc('day', p_from at time zone 'UTC') at time zone 'UTC';
begin
  -- Account-wide hourly, advertiser side: an impression belongs to the owner of
  -- the campaign that was shown.
  insert into public.ad_stats_owner_hourly as t
    (owner_id, hour, paid_impressions, free_impressions, valid_clicks, free_clicks, spent_cents)
  select c.owner_id,
         date_trunc('hour', e.ts),
         sum(e.paid)::bigint, sum(e.free)::bigint, sum(e.clk)::bigint,
         sum(e.fclk)::bigint, sum(e.spent)::bigint
  from (
    select i.campaign_id, i.ts,
           case when i.tier = 'free' then 0 else 1 end as paid,
           case when i.tier = 'free' then 1 else 0 end as free,
           0 as clk, 0 as fclk, 0 as spent
    from public.ad_impressions i
    where not i.duplicate and i.ts >= v_from_hour
    union all
    select cl.campaign_id, cl.ts, 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    where cl.ts >= v_from_hour
  ) e
  join public.ad_campaigns c on c.id = e.campaign_id
  group by 1, 2
  on conflict (owner_id, hour) do update set
    paid_impressions = excluded.paid_impressions,
    free_impressions = excluded.free_impressions,
    valid_clicks     = excluded.valid_clicks,
    free_clicks      = excluded.free_clicks,
    spent_cents      = excluded.spent_cents;

  insert into public.ad_stats_campaign_daily as t
    (campaign_id, day, paid_impressions, free_impressions, valid_clicks, free_clicks, spent_cents)
  select e.campaign_id,
         (e.ts at time zone 'UTC')::date,
         sum(e.paid)::bigint, sum(e.free)::bigint, sum(e.clk)::bigint,
         sum(e.fclk)::bigint, sum(e.spent)::bigint
  from (
    select i.campaign_id, i.ts,
           case when i.tier = 'free' then 0 else 1 end as paid,
           case when i.tier = 'free' then 1 else 0 end as free,
           0 as clk, 0 as fclk, 0 as spent
    from public.ad_impressions i
    where not i.duplicate and i.ts >= v_from_day
    union all
    select cl.campaign_id, cl.ts, 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    where cl.ts >= v_from_day
  ) e
  where e.campaign_id is not null
  group by 1, 2
  on conflict (campaign_id, day) do update set
    paid_impressions = excluded.paid_impressions,
    free_impressions = excluded.free_impressions,
    valid_clicks     = excluded.valid_clicks,
    free_clicks      = excluded.free_clicks,
    spent_cents      = excluded.spent_cents;

  -- Publisher side. invalid_clicks is its own bucket on purpose: a refused
  -- click is not delivery, and folding it into free_clicks would put a
  -- double-digit CTR on the earnings page.
  insert into public.ad_stats_slot_daily as t
    (slot_id, day, paid_impressions, free_impressions, valid_clicks, free_clicks, invalid_clicks, earned_cents)
  select e.slot_id,
         (e.ts at time zone 'UTC')::date,
         sum(e.paid)::bigint, sum(e.free)::bigint, sum(e.clk)::bigint,
         sum(e.fclk)::bigint, sum(e.iclk)::bigint, sum(e.earned)::bigint
  from (
    select i.slot_id, i.ts,
           case when i.tier = 'free' then 0 else 1 end as paid,
           case when i.tier = 'free' then 1 else 0 end as free,
           0 as clk, 0 as fclk, 0 as iclk, 0 as earned
    from public.ad_impressions i
    where not i.duplicate and i.ts >= v_from_day
    union all
    select cl.slot_id, cl.ts, 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when not cl.valid and cl.tier <> 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.publisher_earn_cents, 0) else 0 end
    from public.ad_clicks cl
    where cl.ts >= v_from_day
  ) e
  where e.slot_id is not null
  group by 1, 2
  on conflict (slot_id, day) do update set
    paid_impressions = excluded.paid_impressions,
    free_impressions = excluded.free_impressions,
    valid_clicks     = excluded.valid_clicks,
    free_clicks      = excluded.free_clicks,
    invalid_clicks   = excluded.invalid_clicks,
    earned_cents     = excluded.earned_cents;
end;
$fn$;

revoke all on function public.ad_stats_rollup_refresh(timestamptz) from anon, authenticated;

-- Backfill the whole archive once. p_from covers every event ever recorded.
select public.ad_stats_rollup_refresh('epoch'::timestamptz);

-- Close out finished hours/days. Ten minutes is well inside the one-hour
-- staleness the read path tolerates, and each run only touches two days.
select cron.schedule(
  'ad-stats-rollup',
  '*/10 * * * *',
  $cron$select public.ad_stats_rollup_refresh(now() - interval '2 days')$cron$
);

