-- Ad network: publisher-side totals that count free-tier delivery, over a window.
--
-- ad_slot_stats / ad_campaign_stats split delivery in two — `impressions` is
-- tier 'paid' only, `free_impressions` is tier 'free' — and the earnings page
-- and the slots page each read the paid half and never the free one. Every fill
-- on this network has been free tier since the self-deal demotion landed
-- (one account owns both the campaigns and the slots, so ad_charge_click takes
-- its self-deal branch every time), which is why both pages have read zero for
-- months while the campaigns dashboard, which sums both halves, showed six
-- figures. rssamplifier.com: 116,071 impressions delivered, 0 on the page.
--
-- The views are also lifetime — no window at all — while the earnings page and
-- the PDF report both promise "last N days". So the figures were wrong twice
-- over: the wrong tier, for the wrong period.
--
-- ad_campaign_totals already solves exactly this on the advertiser side. This is
-- its publisher-side twin, same shape and same rules:
--   * security invoker plus an explicit owner_id = auth.uid() scope, so the
--     publisher-side read grants on ad_impressions cannot leak another
--     account's slots in.
--   * one row per slot, never (slots x buckets), so it cannot hit PostgREST's
--     1000-row response cap. See 20260731140000_ad_range_series.sql.
--
-- invalid_clicks has no equivalent on the advertiser side and is the point of
-- the new column. A click we refuse to bill is recorded with valid = false, and
-- resolveClick's insert leaves tier at its 'paid' default, so the row matches
-- neither the billed bucket (valid) nor the free bucket (not valid and tier =
-- 'free'). 57,060 clicks have accumulated in that gap, visible to nothing.
-- They stay out of the delivery figures deliberately — a bot or duplicate click
-- is not delivery, and folding it in would inflate every CTR on the page — but
-- the count is worth showing, because it is most of the click volume.
--
-- Adds a function and nothing else: no existing object is altered, so this is
-- safe to apply before the code that calls it ships.
--
-- Apply via psql over the pooler / MCP (prod history diverged), not `db push`.

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
security invoker
set search_path = public
as $$
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
$$;

grant execute on function public.ad_slot_totals(timestamptz) to authenticated, service_role;
