-- Ad network: per-campaign performance view for the advertiser dashboard.
--
-- security_invoker=true so the underlying ad_impressions/ad_clicks/ad_campaigns
-- RLS applies to the querying user — an advertiser only ever sees stats for
-- campaigns they own. Correlated subqueries (not a join) so impression and
-- click aggregates don't multiply each other.
--
-- Apply via psql over the pooler (prod history diverged), not `db push`.

create or replace view public.ad_campaign_stats
  with (security_invoker = true) as
select
  c.id as campaign_id,
  (select count(*) from public.ad_impressions i where i.campaign_id = c.id) as impressions,
  (select count(*) from public.ad_clicks cl where cl.campaign_id = c.id and cl.valid) as clicks,
  (select coalesce(sum(cl.charged_cents), 0)
     from public.ad_clicks cl where cl.campaign_id = c.id and cl.valid) as spent_cents,
  c.spend_today_cents,
  c.total_spent_cents
from public.ad_campaigns c;

grant select on public.ad_campaign_stats to authenticated, service_role;

-- Publisher side: per-slot performance for the monetize dashboard.
create or replace view public.ad_slot_stats
  with (security_invoker = true) as
select
  s.id as slot_id,
  (select count(*) from public.ad_impressions i where i.slot_id = s.id) as impressions,
  (select count(*) from public.ad_clicks cl where cl.slot_id = s.id and cl.valid) as clicks,
  (select coalesce(sum(cl.publisher_earn_cents), 0)
     from public.ad_clicks cl where cl.slot_id = s.id and cl.valid) as earned_cents
from public.ad_slots s;

grant select on public.ad_slot_stats to authenticated, service_role;
