-- Ad network: a self-deal click is free-tier delivery, not a paid click that
-- happened to fail.
--
-- ad_charge_click refuses to bill when the same profile owns the slot and the
-- campaign — correct, there is no money to move. But that branch recorded the
-- row as `valid=false, tier='paid'`, and reporting reads exactly two kinds of
-- click:
--
--   clicks       = valid                       -- billed
--   free_clicks  = not valid and tier='free'   -- real, unbillable
--
-- `not valid and tier='paid'` is neither, and it is what the bot/duplicate/
-- forged path writes. So every self-deal click landed in the bucket reserved
-- for fraud and disappeared from the dashboard entirely. The two branches
-- either side of it already write 'free' for the same situation — a real click
-- nobody can be charged for — so this was an inconsistency, not a policy.
--
-- serveAd makes the matching call on the impression side: a self-owned
-- campaign is demoted to the free tier rather than dropped (see the comment in
-- lib/ads/serve.ts). This aligns the click side with it.
--
-- Backfill included, because the misclassification is recent and total: while
-- every slot and every campaign belong to one account, 100% of clicks take
-- this branch, and 661 of them are currently invisible. The update is scoped
-- narrowly enough not to touch a genuine fraud row:
--
--   * valid = false and tier = 'paid'  — the only rows in the wrong bucket;
--   * charged_cents = 0                — never move a row that billed;
--   * slot owner = campaign owner      — the self-deal condition itself;
--   * device is distinct from 'bot'    — bots are rejected before this branch,
--                                        so a bot row can only have come from
--                                        the fraud path in resolveClick.
--
-- Duplicate-click rows cannot be caught by mistake: that check requires an
-- existing valid=true click on the campaign inside 6h, and the branch being
-- fixed here is precisely why no such click exists.

create or replace function public.ad_charge_click(
  p_campaign uuid,
  p_slot uuid,
  p_creative uuid,
  p_impression uuid,
  p_visitor text,
  p_ip_hash text,
  p_country text,
  p_device text,
  p_cpc_credits integer,
  p_platform_rate numeric
)
returns table(click_id uuid, charged_cents integer, publisher_earn_cents integer, valid boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Paused / archived campaign: this click should not have been servable at
  -- all, so it stays out of the free-tier figures as well as the paid ones.
  if v_status not in ('active', 'exhausted') then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false,'paid')
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  select owner_id into v_slot_owner from public.ad_slots where id = p_slot;

  -- Self-deal: one account on both sides, so nothing is billed and nothing is
  -- earned. Real delivery all the same — free tier, same as the two branches
  -- below.
  if v_slot_owner is not null and v_slot_owner = v_owner then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid,tier)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false,'free')
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

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
end $function$;

-- create or replace keeps the existing ACL, but state it anyway so a fresh
-- database ends up where 20260731160000_ad_rpc_revoke_public.sql left this one:
-- no PUBLIC execute on a security-definer money function.
revoke execute on function public.ad_charge_click(uuid, uuid, uuid, uuid, text, text, text, text, integer, numeric) from public;
grant execute on function public.ad_charge_click(uuid, uuid, uuid, uuid, text, text, text, text, integer, numeric) to service_role;

-- Reclassify the rows the old branch mislabelled. See the header for why each
-- clause is here; together they select self-deal clicks and nothing else.
update public.ad_clicks c
   set tier = 'free'
  from public.ad_campaigns camp, public.ad_slots s
 where c.campaign_id = camp.id
   and c.slot_id = s.id
   and s.owner_id = camp.owner_id
   and c.valid = false
   and c.tier = 'paid'
   and c.charged_cents = 0
   and c.device is distinct from 'bot';
