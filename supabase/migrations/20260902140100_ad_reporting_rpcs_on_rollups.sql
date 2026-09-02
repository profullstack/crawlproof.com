-- Point the five ad reporting RPCs at the rollups from 20260902140000.
--
-- Every function keeps its name, arguments and output columns, so nothing that
-- reads them has to change except ad_campaign_daily_series (see below). What
-- changes is where the numbers come from:
--
--   closed periods  -> ad_stats_* rollup rows
--   the live edge   -> raw ad_impressions / ad_clicks
--
-- "Closed" means strictly before the current hour (account series) or the
-- current UTC day (everything else). The live edge is therefore at most one
-- hour or one day wide no matter how long the requested window is, which is
-- what makes the cost proportional to the number of buckets plotted rather
-- than to the size of the archive.
--
-- The split is exact, not approximate. When p_since lands mid-period the
-- leading partial period is read from raw too, so a window starting at
-- 13:24 still reports 13:24 onwards and not 14:00 onwards. That is the reason
-- for first_full_hour / first_full_day below rather than a plain date_trunc.
--
-- Semantics are unchanged and deliberately restated here because they have
-- been misread three times: `impressions` and `clicks` are the PAID and VALID
-- halves, `free_impressions` / `free_clicks` are the others, and a caller that
-- reads one without the other sees zero on a network where every fill is free
-- backfill.

-- ---------------------------------------------------------------------------
-- Account-wide series
-- ---------------------------------------------------------------------------
create or replace function public.ad_account_series(
  p_since timestamptz default null,
  p_bucket_seconds integer default 86400
) returns table(
  bucket timestamptz, impressions bigint, free_impressions bigint,
  clicks bigint, free_clicks bigint, spent_cents bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  secs int := greatest(coalesce(p_bucket_seconds, 86400), 60);
  step interval := make_interval(secs => secs);
  uid uuid := auth.uid();
  this_hour timestamptz := date_trunc('hour', now());
  first_full_hour timestamptz;
begin
  if uid is null then
    return;
  end if;

  -- Buckets finer than the rollup grain (the 1H/4H/1D tabs, at 60/300/1800s)
  -- have to come from raw events. They only ever span the last 24 hours, so
  -- the ts index makes that a narrow read rather than the full-archive scan
  -- this function used to do for every range alike.
  if secs < 3600 then
    return query
    with ev as (
      select date_bin(step, i.ts, timestamptz 'epoch') as b,
             case when i.tier = 'free' then 0 else 1 end as paid,
             case when i.tier = 'free' then 1 else 0 end as free,
             0 as clk, 0 as fclk, 0 as spent
      from public.ad_impressions i
      join public.ad_campaigns c on c.id = i.campaign_id and c.owner_id = uid
      where not i.duplicate and (p_since is null or i.ts >= p_since)
      union all
      select date_bin(step, cl.ts, timestamptz 'epoch'), 0, 0,
             case when cl.valid then 1 else 0 end,
             case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
             case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
      from public.ad_clicks cl
      join public.ad_campaigns c on c.id = cl.campaign_id and c.owner_id = uid
      where (p_since is null or cl.ts >= p_since)
    )
    select b, sum(paid)::bigint, sum(free)::bigint, sum(clk)::bigint,
           sum(fclk)::bigint, sum(spent)::bigint
    from ev group by b order by b;
    return;
  end if;

  first_full_hour := case
    when p_since is null then null
    when p_since = date_trunc('hour', p_since) then p_since
    else date_trunc('hour', p_since) + interval '1 hour'
  end;

  return query
  with ev as (
    select date_bin(step, r.hour, timestamptz 'epoch') as b,
           r.paid_impressions as paid, r.free_impressions as free,
           r.valid_clicks as clk, r.free_clicks as fclk, r.spent_cents as spent
    from public.ad_stats_owner_hourly r
    where r.owner_id = uid
      and r.hour < this_hour
      and (first_full_hour is null or r.hour >= first_full_hour)
    union all
    select date_bin(step, i.ts, timestamptz 'epoch'),
           case when i.tier = 'free' then 0 else 1 end,
           case when i.tier = 'free' then 1 else 0 end,
           0, 0, 0
    from public.ad_impressions i
    join public.ad_campaigns c on c.id = i.campaign_id and c.owner_id = uid
    where not i.duplicate
      and (p_since is null or i.ts >= p_since)
      and (i.ts >= this_hour
           or (first_full_hour is not null and i.ts < first_full_hour))
    union all
    select date_bin(step, cl.ts, timestamptz 'epoch'), 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    join public.ad_campaigns c on c.id = cl.campaign_id and c.owner_id = uid
    where (p_since is null or cl.ts >= p_since)
      and (cl.ts >= this_hour
           or (first_full_hour is not null and cl.ts < first_full_hour))
  )
  select b, sum(paid)::bigint, sum(free)::bigint, sum(clk)::bigint,
         sum(fclk)::bigint, sum(spent)::bigint
  from ev group by b order by b;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-campaign totals for a window
-- ---------------------------------------------------------------------------
create or replace function public.ad_campaign_totals(
  p_since timestamptz default null
) returns table(
  campaign_id uuid, impressions bigint, free_impressions bigint,
  clicks bigint, free_clicks bigint, spent_cents bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'UTC')::date;
  today_start timestamptz := (today::timestamp at time zone 'UTC');
  first_full_day date;
  first_full_start timestamptz;
begin
  if uid is null then
    return;
  end if;

  first_full_day := case
    when p_since is null then null
    when p_since = ((p_since at time zone 'UTC')::date::timestamp at time zone 'UTC')
      then (p_since at time zone 'UTC')::date
    else (p_since at time zone 'UTC')::date + 1
  end;
  first_full_start := (first_full_day::timestamp at time zone 'UTC');

  return query
  with owned as (
    select id from public.ad_campaigns where owner_id = uid
  ),
  ev as (
    select r.campaign_id,
           r.paid_impressions as paid, r.free_impressions as free,
           r.valid_clicks as clk, r.free_clicks as fclk, r.spent_cents as spent
    from public.ad_stats_campaign_daily r
    where r.campaign_id in (select id from owned)
      and r.day < today
      and (first_full_day is null or r.day >= first_full_day)
    union all
    select i.campaign_id,
           case when i.tier = 'free' then 0 else 1 end,
           case when i.tier = 'free' then 1 else 0 end,
           0, 0, 0
    from public.ad_impressions i
    where i.campaign_id in (select id from owned)
      and not i.duplicate
      and (p_since is null or i.ts >= p_since)
      and (i.ts >= today_start
           or (first_full_start is not null and i.ts < first_full_start))
    union all
    select cl.campaign_id, 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    where cl.campaign_id in (select id from owned)
      and (p_since is null or cl.ts >= p_since)
      and (cl.ts >= today_start
           or (first_full_start is not null and cl.ts < first_full_start))
  )
  select ev.campaign_id, sum(paid)::bigint, sum(free)::bigint, sum(clk)::bigint,
         sum(fclk)::bigint, sum(spent)::bigint
  from ev group by ev.campaign_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-campaign daily series
-- ---------------------------------------------------------------------------
-- Now returns a single jsonb array instead of a set of rows, because the set
-- had outgrown PostgREST's 1000-row response cap: 139 campaigns over 30 days is
-- 2,731 rows, and the request was coming back `206 Partial Content,
-- content-range 0-999/2731`. The function has no ORDER BY, so *which* two
-- thirds were dropped was down to the join order -- campaigns silently lost
-- recent days off their sparkline, and five lost every row and rendered
-- "no traffic yet" beside a row reading "Impressions: 24".
--
-- One jsonb document is one row, so the cap cannot apply however many campaigns
-- the account grows to.
--
-- The set-returning version has to go before the jsonb one can be created:
-- `create or replace` cannot change a function's return type, and leaving the
-- old signature in place would also let it win overload resolution for an
-- integer argument.
drop function if exists public.ad_campaign_daily_series(integer);

create function public.ad_campaign_daily_series(
  days integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  n int := greatest(coalesce(days, 30), 1);
  today date := (now() at time zone 'UTC')::date;
  today_start timestamptz := (today::timestamp at time zone 'UTC');
  from_day date;
begin
  if uid is null then
    return '[]'::jsonb;
  end if;
  from_day := today - (n - 1);

  return coalesce((
    with owned as (
      select id from public.ad_campaigns where owner_id = uid
    ),
    ev as (
      select r.campaign_id, r.day,
             (r.paid_impressions + r.free_impressions) as impressions,
             r.valid_clicks as clicks, r.spent_cents as spent
      from public.ad_stats_campaign_daily r
      where r.campaign_id in (select id from owned)
        and r.day >= from_day and r.day < today
      union all
      select i.campaign_id, today, 1::bigint, 0::bigint, 0::bigint
      from public.ad_impressions i
      where i.campaign_id in (select id from owned)
        and not i.duplicate and i.ts >= today_start
      union all
      select cl.campaign_id, today, 0::bigint,
             case when cl.valid then 1 else 0 end::bigint,
             case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end::bigint
      from public.ad_clicks cl
      where cl.campaign_id in (select id from owned)
        and cl.ts >= today_start
    )
    -- The group-by has to finish before jsonb_agg runs, or aggregating over
    -- grouped rows yields one single-element array per group instead of one
    -- array of every day.
    select jsonb_agg(row_to_json(g))
    from (
      select campaign_id,
             day,
             sum(impressions)::bigint as impressions,
             sum(clicks)::bigint      as clicks,
             sum(spent)::bigint       as spent_cents
      from ev
      group by campaign_id, day
      -- A rollup row exists for any activity in the cell, including a day whose
      -- only events were free or invalid clicks. The set-returning version this
      -- replaces joined impressions to VALID clicks, so it never emitted such a
      -- cell, and emitting it now would add all-zero points the caller already
      -- zero-fills for itself. Keep the output identical.
      having sum(impressions) > 0 or sum(clicks) > 0
    ) g
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Publisher side
-- ---------------------------------------------------------------------------
create or replace function public.ad_slot_totals(
  p_since timestamptz default null
) returns table(
  slot_id uuid, impressions bigint, free_impressions bigint, clicks bigint,
  free_clicks bigint, invalid_clicks bigint, earned_cents bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'UTC')::date;
  today_start timestamptz := (today::timestamp at time zone 'UTC');
  first_full_day date;
  first_full_start timestamptz;
begin
  if uid is null then
    return;
  end if;

  first_full_day := case
    when p_since is null then null
    when p_since = ((p_since at time zone 'UTC')::date::timestamp at time zone 'UTC')
      then (p_since at time zone 'UTC')::date
    else (p_since at time zone 'UTC')::date + 1
  end;
  first_full_start := (first_full_day::timestamp at time zone 'UTC');

  return query
  with owned as (
    select id from public.ad_slots where owner_id = uid
  ),
  ev as (
    select r.slot_id, r.paid_impressions as paid, r.free_impressions as free,
           r.valid_clicks as clk, r.free_clicks as fclk,
           r.invalid_clicks as iclk, r.earned_cents as earned
    from public.ad_stats_slot_daily r
    where r.slot_id in (select id from owned)
      and r.day < today
      and (first_full_day is null or r.day >= first_full_day)
    union all
    select i.slot_id,
           case when i.tier = 'free' then 0 else 1 end,
           case when i.tier = 'free' then 1 else 0 end,
           0, 0, 0, 0
    from public.ad_impressions i
    where i.slot_id in (select id from owned)
      and not i.duplicate
      and (p_since is null or i.ts >= p_since)
      and (i.ts >= today_start
           or (first_full_start is not null and i.ts < first_full_start))
    union all
    select cl.slot_id, 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when not cl.valid and cl.tier <> 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.publisher_earn_cents, 0) else 0 end
    from public.ad_clicks cl
    where cl.slot_id in (select id from owned)
      and (p_since is null or cl.ts >= p_since)
      and (cl.ts >= today_start
           or (first_full_start is not null and cl.ts < first_full_start))
  )
  select ev.slot_id, sum(paid)::bigint, sum(free)::bigint, sum(clk)::bigint,
         sum(fclk)::bigint, sum(iclk)::bigint, sum(earned)::bigint
  from ev group by ev.slot_id;
end;
$$;

create or replace function public.ad_slot_daily_series(
  days integer default 30
) returns table(slot_id uuid, day date, clicks bigint, earned_cents bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  n int := greatest(coalesce(days, 30), 1);
  today date := (now() at time zone 'UTC')::date;
  today_start timestamptz := (today::timestamp at time zone 'UTC');
  from_day date;
begin
  if uid is null then
    return;
  end if;
  from_day := today - (n - 1);

  return query
  with owned as (
    select id from public.ad_slots where owner_id = uid
  ),
  ev as (
    select r.slot_id, r.day, r.valid_clicks as clk, r.earned_cents as earned
    from public.ad_stats_slot_daily r
    where r.slot_id in (select id from owned)
      and r.day >= from_day and r.day < today
    union all
    select cl.slot_id, today, 1::bigint,
           coalesce(cl.publisher_earn_cents, 0)::bigint
    from public.ad_clicks cl
    where cl.slot_id in (select id from owned)
      and cl.valid and cl.ts >= today_start
  )
  select ev.slot_id, ev.day, sum(clk)::bigint, sum(earned)::bigint
  from ev group by ev.slot_id, ev.day
  -- Same reason as ad_campaign_daily_series above: this function has only ever
  -- reported days on which a valid click landed, and ad_stats_slot_daily also
  -- carries days that saw impressions alone. Without this the 30-day call goes
  -- from 38 rows to 1,481, nearly all of them zero.
  having sum(clk) > 0;
end;
$$;

