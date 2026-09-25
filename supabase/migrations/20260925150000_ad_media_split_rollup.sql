-- Reporting the presentation rotation: delivery and clicks per medium.
--
-- #316 started choosing a medium per fill and recording it on
-- ad_impressions.media. That column is the whole return on rotating — without a
-- read of it the feature is randomised delivery that teaches nothing — and
-- nothing consumed it until this migration.
--
-- It is a rollup rather than a query over raw events for the reason
-- 20260902140000 exists: ad_impressions is ~376k rows growing ~90k/day, a 30-day
-- window selects about half the table, and the 8s statement_timeout on
-- `authenticated` was already cancelling reporting RPCs that scanned it. Adding
-- a `group by media` over the same raw range would walk straight back into that.
--
-- GRAIN: (owner_id, day, media). Daily rather than the account series' hourly
-- because this is a comparison table, not a plotted series — nothing here is
-- drawn at 4-hour buckets, so the finer grain would cost rows and buy nothing.
-- At six possible media that is ~6 rows per owner per day.
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler, do NOT `supabase db push`. And send
-- `notify pgrst, 'reload schema';` afterwards or PostgREST will not see the new
-- function.

-- 1. The rollup. --------------------------------------------------------------
--
-- `media` is not null so it can carry the primary key, so the two genuinely
-- unattributable cases are folded into one honest bucket rather than dropped:
--
--   * an impression served before #316 shipped, whose media column is NULL. It
--     belongs to no arm and must not be counted as 'static' — that would put
--     the entire pre-rotation archive into one arm of the experiment and make
--     static look like the runaway winner forever.
--   * a click whose impression_id is null or no longer resolves. ad_clicks has
--     `on delete set null`, and serveAd synthesises an impression id when its
--     own insert failed, so a click can exist with nothing to attribute it to.
--
-- Both land in 'unknown', which the dashboard reports separately and never
-- includes in a share or a rate.
create table if not exists public.ad_stats_owner_media_daily (
  owner_id          uuid        not null,
  day               date        not null,
  media             text        not null,
  paid_impressions  bigint      not null default 0,
  free_impressions  bigint      not null default 0,
  valid_clicks      bigint      not null default 0,
  free_clicks       bigint      not null default 0,
  spent_cents       bigint      not null default 0,
  primary key (owner_id, day, media)
);

alter table public.ad_stats_owner_media_daily enable row level security;

-- Read through the SECURITY DEFINER RPC below, exactly as the other rollups are.
-- No policy: the rollups are not addressable directly by `authenticated`.

-- 2. Refresh, extending the existing one. -------------------------------------
--
-- Same contract as ad_stats_rollup_refresh: a full recompute of the touched
-- periods rather than a delta, because ad_clicks rows are updated after insert
-- (charged, or later invalidated) and counting only new rows would drift.
create or replace function public.ad_stats_media_rollup_refresh(
  p_from timestamptz default (now() - interval '2 days')
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  -- Snap down to a whole day before recomputing: p_from lands mid-day, and
  -- filtering raw events on it directly would upsert a partial count over the
  -- complete row already stored for that day.
  v_from_day timestamptz := date_trunc('day', p_from at time zone 'UTC') at time zone 'UTC';
begin
  insert into public.ad_stats_owner_media_daily as t
    (owner_id, day, media, paid_impressions, free_impressions,
     valid_clicks, free_clicks, spent_cents)
  select c.owner_id,
         (e.ts at time zone 'UTC')::date,
         e.media,
         sum(e.paid)::bigint, sum(e.free)::bigint, sum(e.clk)::bigint,
         sum(e.fclk)::bigint, sum(e.spent)::bigint
  from (
    select i.campaign_id, i.ts, coalesce(i.media, 'unknown') as media,
           case when i.tier = 'free' then 0 else 1 end as paid,
           case when i.tier = 'free' then 1 else 0 end as free,
           0 as clk, 0 as fclk, 0 as spent
    from public.ad_impressions i
    where not i.duplicate and i.ts >= v_from_day
    union all
    -- A click's medium is the medium of the impression it came from: the click
    -- row has no presentation of its own, and inferring one from the creative
    -- would be wrong the moment the same creative serves two arms.
    select cl.campaign_id, cl.ts, coalesce(i.media, 'unknown'),
           0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    left join public.ad_impressions i on i.id = cl.impression_id
    where cl.ts >= v_from_day
  ) e
  join public.ad_campaigns c on c.id = e.campaign_id
  group by 1, 2, 3
  on conflict (owner_id, day, media) do update set
    paid_impressions = excluded.paid_impressions,
    free_impressions = excluded.free_impressions,
    valid_clicks     = excluded.valid_clicks,
    free_clicks      = excluded.free_clicks,
    spent_cents      = excluded.spent_cents;
end;
$fn$;

revoke all on function public.ad_stats_media_rollup_refresh(timestamptz) from public;

-- 3. The read. ----------------------------------------------------------------
--
-- Closed days come from the rollup, the current UTC day (and any leading
-- partial day when p_since lands mid-day) from raw — the same exact split the
-- other reporting RPCs use, so the live edge is at most one day wide however
-- long the window.
create or replace function public.ad_owner_media_split(
  p_since timestamptz default null
) returns table(
  media text, impressions bigint, free_impressions bigint,
  clicks bigint, free_clicks bigint, spent_cents bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  uid uuid := auth.uid();
  today_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  first_full_day date;
begin
  if uid is null then
    return;
  end if;

  first_full_day := case
    when p_since is null then null
    when p_since = date_trunc('day', p_since at time zone 'UTC') at time zone 'UTC'
      then (p_since at time zone 'UTC')::date
    else ((p_since at time zone 'UTC')::date + 1)
  end;

  return query
  with ev as (
    select r.media, r.paid_impressions as paid, r.free_impressions as free,
           r.valid_clicks as clk, r.free_clicks as fclk, r.spent_cents as spent
    from public.ad_stats_owner_media_daily r
    where r.owner_id = uid
      and r.day < (today_start at time zone 'UTC')::date
      and (first_full_day is null or r.day >= first_full_day)
    union all
    select coalesce(i.media, 'unknown'),
           case when i.tier = 'free' then 0 else 1 end,
           case when i.tier = 'free' then 1 else 0 end,
           0, 0, 0
    from public.ad_impressions i
    join public.ad_campaigns c on c.id = i.campaign_id and c.owner_id = uid
    where not i.duplicate
      and i.ts >= greatest(today_start, coalesce(p_since, today_start))
      and (p_since is null or i.ts >= p_since)
    union all
    select coalesce(i.media, 'unknown'), 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    join public.ad_campaigns c on c.id = cl.campaign_id and c.owner_id = uid
    left join public.ad_impressions i on i.id = cl.impression_id
    where cl.ts >= greatest(today_start, coalesce(p_since, today_start))
      and (p_since is null or cl.ts >= p_since)
  )
  select ev.media, sum(ev.paid)::bigint, sum(ev.free)::bigint,
         sum(ev.clk)::bigint, sum(ev.fclk)::bigint, sum(ev.spent)::bigint
  from ev group by ev.media order by (sum(ev.paid) + sum(ev.free)) desc;
end;
$$;

revoke all on function public.ad_owner_media_split(timestamptz) from public;
grant execute on function public.ad_owner_media_split(timestamptz) to authenticated;

-- 4. Schedule the refresh beside the existing one. ----------------------------
--
-- Guarded: pg_cron is present on the self-hosted stack, but a migration that
-- hard-depends on it cannot be applied anywhere it is not.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('ad-stats-media-rollup')
      where exists (select 1 from cron.job where jobname = 'ad-stats-media-rollup');
    perform cron.schedule(
      'ad-stats-media-rollup',
      '7,37 * * * *',
      $cmd$select public.ad_stats_media_rollup_refresh();$cmd$
    );
  end if;
end
$$;
