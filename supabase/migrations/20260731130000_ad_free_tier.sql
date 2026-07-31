-- Ad network — Phase 6: campaigns never go dark, they drop to a free tier.
--
-- Running out of money used to kill a campaign. ad_charge_click flipped
-- ad_campaigns.status to 'exhausted' and nothing ever flipped it back — a
-- deposit granted credits but didn't touch campaign status — so the advertiser
-- had to notice and press Activate. Meanwhile the slot that would have shown
-- their ad fell back to a CrawlProof house ad, which earns the publisher
-- exactly as little as the free-tier ad would have.
--
-- Now a dry campaign keeps serving as FREE BACKFILL: it fills requests no
-- paying campaign wanted, bills nobody, and accrues nothing to the publisher.
-- Strictly better than a house ad for everyone — the advertiser keeps getting
-- traffic and a reason to top up, the publisher shows a real ad, and the
-- network keeps its inventory full. Paid delivery resumes by itself the moment
-- credits arrive or the daily budget rolls over at 00:00 UTC.
--
-- Solvency is untouched: free-tier clicks charge 0 and accrue 0, so they add no
-- publisher liability. See 20260731120000_ad_solvency.sql.
--
-- Apply via psql over the pooler (prod history diverged), not `db push`.

-- ---------------------------------------------------------------------------
-- Tier provenance on the event tables
-- ---------------------------------------------------------------------------

-- Which inventory the event came from. 'paid' = won the auction and billed;
-- 'free' = backfill, unbilled. House ads are never recorded, so they need no
-- value here. Existing rows all predate the free tier, so 'paid' is right.
alter table public.ad_impressions
  add column if not exists tier text not null default 'paid';
alter table public.ad_clicks
  add column if not exists tier text not null default 'paid';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ad_impressions_tier_check') then
    alter table public.ad_impressions
      add constraint ad_impressions_tier_check check (tier in ('paid','free'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ad_clicks_tier_check') then
    alter table public.ad_clicks
      add constraint ad_clicks_tier_check check (tier in ('paid','free'));
  end if;
end $$;

create index if not exists ad_impressions_tier_idx on public.ad_impressions (tier);
create index if not exists ad_clicks_tier_idx on public.ad_clicks (tier);

-- ---------------------------------------------------------------------------
-- Revive every campaign that was killed by the old behaviour
-- ---------------------------------------------------------------------------

-- 'exhausted' is no longer written. Rows still carrying it are live campaigns
-- that ran dry; they belong on the free tier, not dark. serveAd() and
-- campaignTier() both tolerate the legacy value, but clear it so the dashboard
-- and the auction agree on one representation.
update public.ad_campaigns set status = 'active' where status = 'exhausted';

-- ---------------------------------------------------------------------------
-- Charge a click: free tier instead of deactivation
-- ---------------------------------------------------------------------------

create or replace function public.ad_charge_click(
  p_campaign uuid,
  p_slot uuid,
  p_creative uuid,
  p_impression uuid,
  p_visitor text,
  p_ip_hash text,
  p_country text,
  p_device text,
  p_cpc_credits int,
  p_platform_rate numeric
) returns table(click_id uuid, charged_cents int, publisher_earn_cents int, valid boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_status text;
  v_daily int;
  v_spend int;
  v_date date;
  v_paid int;
  v_bonus int;
  v_promo int;
  v_from_bonus int;
  v_from_promo int;
  v_from_cash int;
  v_rest int;
  v_slot_owner uuid;
  v_charged int;
  v_earn int;
  v_cut int;
  v_click uuid;
  v_rack_cents constant int := 5;
  v_floor_cents constant numeric := 2.0;
begin
  select owner_id, status, daily_budget_cents, spend_today_cents, spend_date
    into v_owner, v_status, v_daily, v_spend, v_date
  from public.ad_campaigns where id = p_campaign for update;
  if not found then return; end if;

  v_charged := p_cpc_credits * v_rack_cents;
  if v_date is distinct from current_date then v_spend := 0; end if;

  -- Paused / draft: not serving at all, so this click shouldn't exist. Record
  -- it unbilled on the paid tier — it was never free inventory.
  if v_status not in ('active', 'exhausted') then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false,'paid')
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  select owner_id into v_slot_owner from public.ad_slots where id = p_slot;

  -- Self-dealing: clicking your own ad on your own slot moves credits into
  -- withdrawable cash for free. Bill nobody, earn nobody.
  if v_slot_owner is not null and v_slot_owner = v_owner then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false,'paid')
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  -- Over the daily cap: free tier for the rest of the UTC day. The campaign
  -- stays active and resumes paid delivery on its own at midnight.
  if (v_spend + v_charged) > v_daily then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false,'free')
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  select credits_balance,
         coalesce(ad_bonus_credits, 0),
         least(coalesce(promo_credits, 0), credits_balance)
    into v_paid, v_bonus, v_promo
  from public.profiles where id = v_owner for update;

  -- Out of credits: free tier. Crucially the status is NOT touched — the old
  -- code set 'exhausted' here and the campaign never came back on its own.
  -- A top-up restores paid delivery with no advertiser action.
  if coalesce(v_paid, 0) + coalesce(v_bonus, 0) < p_cpc_credits then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false,'free')
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  v_from_bonus := least(v_bonus, p_cpc_credits);
  v_rest := p_cpc_credits - v_from_bonus;
  v_from_promo := least(v_promo, v_rest);
  v_from_cash := v_rest - v_from_promo;

  update public.profiles
    set ad_bonus_credits = ad_bonus_credits - v_from_bonus,
        credits_balance = credits_balance - (v_from_promo + v_from_cash),
        promo_credits = greatest(0, coalesce(promo_credits, 0) - v_from_promo)
    where id = v_owner;

  -- Publisher earns at the floor rate, and ONLY on the cash-backed slice.
  v_earn := floor(v_from_cash * (1 - p_platform_rate) * v_floor_cents);
  v_cut := v_charged - v_earn;

  update public.ad_campaigns
    set spend_today_cents = v_spend + v_charged,
        spend_date = current_date,
        total_spent_cents = coalesce(total_spent_cents,0) + v_charged
    where id = p_campaign;

  insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
    values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,v_charged,v_earn,v_cut,true,'paid')
    returning id into v_click;

  if v_slot_owner is not null and v_earn > 0 then
    insert into public.ad_ledger(kind, owner_id, campaign_id, slot_id, amount_cents, ref_click_id)
      values ('publisher_accrual', v_slot_owner, p_campaign, p_slot, v_earn, v_click);
  end if;
  if v_cut > 0 then
    insert into public.ad_ledger(kind, owner_id, campaign_id, slot_id, amount_cents, ref_click_id)
      values ('platform_fee', null, p_campaign, p_slot, v_cut, v_click);
  end if;

  return query select v_click, v_charged, v_earn, true;
end $$;

revoke execute on function public.ad_charge_click(uuid,uuid,uuid,uuid,text,text,text,text,int,numeric) from anon, authenticated;
grant execute on function public.ad_charge_click(uuid,uuid,uuid,uuid,text,text,text,text,int,numeric) to service_role;

-- ---------------------------------------------------------------------------
-- Stats: keep paid and free delivery visible side by side
-- ---------------------------------------------------------------------------

-- Without the split, free-tier delivery would inflate impression counts while
-- spend and earnings stayed flat — an advertiser would think their CPC
-- collapsed and a publisher would think their RPM did.
--
-- Dropped rather than replaced: the new free_* columns land mid-list, and
-- `create or replace view` can only append columns, not insert them.
drop view if exists public.ad_campaign_stats;
drop view if exists public.ad_slot_stats;

create or replace view public.ad_campaign_stats
  with (security_invoker = true) as
select
  c.id as campaign_id,
  (select count(*) from public.ad_impressions i
     where i.campaign_id = c.id and i.tier = 'paid') as impressions,
  (select count(*) from public.ad_impressions i
     where i.campaign_id = c.id and i.tier = 'free') as free_impressions,
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
     where i.slot_id = s.id and i.tier = 'paid') as impressions,
  (select count(*) from public.ad_impressions i
     where i.slot_id = s.id and i.tier = 'free') as free_impressions,
  (select count(*) from public.ad_clicks cl
     where cl.slot_id = s.id and cl.valid) as clicks,
  (select count(*) from public.ad_clicks cl
     where cl.slot_id = s.id and not cl.valid and cl.tier = 'free') as free_clicks,
  (select coalesce(sum(cl.publisher_earn_cents), 0)
     from public.ad_clicks cl where cl.slot_id = s.id and cl.valid) as earned_cents
from public.ad_slots s;

grant select on public.ad_slot_stats to authenticated, service_role;
