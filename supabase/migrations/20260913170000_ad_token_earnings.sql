-- API tokens authenticate outside Supabase Auth. Use an explicit owner rather
-- than auth.uid(), and read closed-day rollups plus today's events once.
-- One JSON document avoids PostgREST's row cap on campaign/day series.
create or replace function public.ad_token_earnings(p_owner uuid, p_days integer)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  today date := (now() at time zone 'UTC')::date;
  today_start timestamptz := today::timestamp at time zone 'UTC';
  from_day date;
begin
  if p_owner is null or p_days is null or p_days not in (7, 30, 90, 365) then
    raise exception 'An owner and supported reporting window are required' using errcode = '22023';
  end if;
  from_day := today - (p_days - 1);
  return (
    with campaigns as materialized (
      select id from public.ad_campaigns where owner_id = p_owner
    ), slots as materialized (
      select s.id from public.ad_slots s
      join public.projects p on p.id = s.project_id and p.owner_id = p_owner
      where s.owner_id = p_owner
    ), campaign_events as (
      select r.campaign_id, r.day, r.paid_impressions as paid, r.free_impressions as free,
             r.valid_clicks as billed, r.free_clicks as unbilled, r.spent_cents as spent
      from public.ad_stats_campaign_daily r join campaigns c on c.id = r.campaign_id
      where r.day >= from_day and r.day < today
      union all
      select i.campaign_id, today, (i.tier <> 'free')::int, (i.tier = 'free')::int, 0, 0, 0
      from public.ad_impressions i join campaigns c on c.id = i.campaign_id
      where not i.duplicate and i.ts >= today_start and i.ts <= now()
      union all
      select cl.campaign_id, today, 0, 0, cl.valid::int,
             (not cl.valid and cl.tier = 'free')::int,
             case when cl.valid then coalesce(cl.charged_cents, 0) else 0 end
      from public.ad_clicks cl join campaigns c on c.id = cl.campaign_id
      where cl.ts >= today_start and cl.ts <= now()
    ), campaign_days as materialized (
      select campaign_id, day, sum(paid)::bigint as paid, sum(free)::bigint as free,
             sum(billed)::bigint as billed, sum(unbilled)::bigint as unbilled,
             sum(spent)::bigint as spent
      from campaign_events group by campaign_id, day
    ), slot_events as (
      select r.slot_id, r.day, r.paid_impressions as paid, r.free_impressions as free,
             r.valid_clicks as billed, r.free_clicks as unbilled,
             r.invalid_clicks as rejected, r.earned_cents as earned
      from public.ad_stats_slot_daily r join slots s on s.id = r.slot_id
      where r.day >= from_day and r.day < today
      union all
      select i.slot_id, today, (i.tier <> 'free')::int, (i.tier = 'free')::int, 0, 0, 0, 0
      from public.ad_impressions i join slots s on s.id = i.slot_id
      where not i.duplicate and i.ts >= today_start and i.ts <= now()
      union all
      select cl.slot_id, today, 0, 0, cl.valid::int,
             (not cl.valid and cl.tier = 'free')::int,
             (not cl.valid and cl.tier <> 'free')::int,
             case when cl.valid then coalesce(cl.publisher_earn_cents, 0) else 0 end
      from public.ad_clicks cl join slots s on s.id = cl.slot_id
      where cl.ts >= today_start and cl.ts <= now()
    ), slot_days as materialized (
      select slot_id, day, sum(paid)::bigint as paid, sum(free)::bigint as free,
             sum(billed)::bigint as billed, sum(unbilled)::bigint as unbilled,
             sum(rejected)::bigint as rejected, sum(earned)::bigint as earned
      from slot_events group by slot_id, day
    ), campaign_totals as (
      select campaign_id, sum(paid)::bigint as impressions, sum(free)::bigint as free_impressions,
             sum(billed)::bigint as clicks, sum(unbilled)::bigint as free_clicks,
             sum(spent)::bigint as spent_cents
      from campaign_days group by campaign_id
    ), slot_totals as (
      select slot_id, sum(paid)::bigint as impressions, sum(free)::bigint as free_impressions,
             sum(billed)::bigint as clicks, sum(unbilled)::bigint as free_clicks,
             sum(rejected)::bigint as invalid_clicks, sum(earned)::bigint as earned_cents
      from slot_days group by slot_id
    ), money as (
      select day, spent, 0::bigint as earned from campaign_days
      union all select day, 0::bigint, earned from slot_days
    ), daily as (
      select day as date, sum(spent)::bigint as "spentCents", sum(earned)::bigint as "earnedCents"
      from money group by day
    )
    select jsonb_build_object(
      'asOf', now(), 'since', from_day, 'rangeDays', p_days,
      'campaigns', coalesce((select jsonb_agg(to_jsonb(c) order by campaign_id) from campaign_totals c), '[]'::jsonb),
      'slots', coalesce((select jsonb_agg(to_jsonb(s) order by slot_id) from slot_totals s), '[]'::jsonb),
      'daily', coalesce((select jsonb_agg(to_jsonb(d) order by date) from daily d), '[]'::jsonb)
    )
  );
end;
$fn$;

-- This function accepts an owner from the trusted API, never from a browser.
revoke all on function public.ad_token_earnings(uuid, integer) from public, anon, authenticated;
grant execute on function public.ad_token_earnings(uuid, integer) to service_role;
notify pgrst, 'reload schema';
