-- Delivery by medium: take the formats that cannot rotate out of the experiment.
--
-- 20260925150000 booked every fill under the medium it was served as, and a
-- feed item, a text link and a terminal unit are always served as 'static' —
-- they have exactly one presentation (mediaKindsForFormat in lib/ads/media.ts).
-- Those formats are ~95% of the network's fills, so the card read
-- "Static 98.7%" while a 300x250 was actually splitting 46% static, which is
-- what a pool with ~40% of campaigns rendered should produce. Static was
-- winning an arm it could not lose.
--
-- The clicks went the same way: every click in the window is invalid, and the
-- bulk are crawlers replaying feed-item links from impressions days to weeks
-- old. Counted as 'static' (or as 'unknown' when the impression predates the
-- media column) they lifted the table over the 30-click gate and put a CTR
-- column on five arms that had six banner clicks between them.
--
-- Fix: a fourth bucket, 'fixed', for any fill whose creative's format does not
-- rotate. It is reported and never shared or rated, like 'unknown'. The format
-- comes from the creative (impressions and clicks both carry creative_id), so a
-- click whose impression was deleted still lands in the right bucket.
--
-- The rotating formats are listed here by hand; tests/contract/
-- ads-media-split-fixed-formats pins the list to rotatesMedia().

create or replace function public.ad_media_bucket(p_format text, p_media text)
returns text
language sql
immutable
as $$
  select case
    when p_format in ('banner_300x250', 'banner_728x90', 'banner_320x50')
      then coalesce(p_media, 'unknown')
    else 'fixed'
  end;
$$;

-- Refresh. Now DELETES the window before re-inserting: an upsert only touches
-- the keys it produces, so a (owner, day, 'static') row computed under the old
-- bucketing would otherwise sit beside the new 'fixed' row forever.
create or replace function public.ad_stats_media_rollup_refresh(
  p_from timestamptz default (now() - interval '2 days')
) returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_from_day timestamptz := date_trunc('day', p_from at time zone 'UTC') at time zone 'UTC';
begin
  delete from public.ad_stats_owner_media_daily
  where day >= (v_from_day at time zone 'UTC')::date;

  insert into public.ad_stats_owner_media_daily as t
    (owner_id, day, media, paid_impressions, free_impressions,
     valid_clicks, free_clicks, spent_cents)
  select c.owner_id,
         (e.ts at time zone 'UTC')::date,
         e.media,
         sum(e.paid)::bigint, sum(e.free)::bigint, sum(e.clk)::bigint,
         sum(e.fclk)::bigint, sum(e.spent)::bigint
  from (
    select i.campaign_id, i.ts, public.ad_media_bucket(cr.format, i.media) as media,
           case when i.tier = 'free' then 0 else 1 end as paid,
           case when i.tier = 'free' then 1 else 0 end as free,
           0 as clk, 0 as fclk, 0 as spent
    from public.ad_impressions i
    join public.ad_creatives cr on cr.id = i.creative_id
    where not i.duplicate and i.ts >= v_from_day
    union all
    select cl.campaign_id, cl.ts, public.ad_media_bucket(cr.format, i.media),
           0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    join public.ad_creatives cr on cr.id = cl.creative_id
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

-- The read: unchanged apart from the live edge using the same bucketing.
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
    select public.ad_media_bucket(cr.format, i.media),
           case when i.tier = 'free' then 0 else 1 end,
           case when i.tier = 'free' then 1 else 0 end,
           0, 0, 0
    from public.ad_impressions i
    join public.ad_campaigns c on c.id = i.campaign_id and c.owner_id = uid
    join public.ad_creatives cr on cr.id = i.creative_id
    where not i.duplicate
      and i.ts >= greatest(today_start, coalesce(p_since, today_start))
      and (p_since is null or i.ts >= p_since)
    union all
    select public.ad_media_bucket(cr.format, i.media), 0, 0,
           case when cl.valid then 1 else 0 end,
           case when not cl.valid and cl.tier = 'free' then 1 else 0 end,
           case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
    from public.ad_clicks cl
    join public.ad_campaigns c on c.id = cl.campaign_id and c.owner_id = uid
    join public.ad_creatives cr on cr.id = cl.creative_id
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

-- Rebuild the whole rollup under the new bucketing, from the oldest raw event
-- rather than from the rollup's own first day: 20260925150000 only filled the
-- two days before it shipped, so a "last 30 days" card was reading one week.
select public.ad_stats_media_rollup_refresh(
  least((select min(ts) from public.ad_impressions),
        (select min(ts) from public.ad_clicks),
        now() - interval '2 days')
);
