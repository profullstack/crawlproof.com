-- Ad network — Phase 4: floor-rate payouts, deposit-match promo, simple bids.
--
-- Solvency model (see the ad-network chat): advertisers SPEND credits valued at
-- rack (5c) but publishers CASH OUT at the floor price (2.5c) — the cheapest we
-- ever sell a credit. That 2:1 spread means a valid click that costs the
-- advertiser N credits only ever obligates 0.7*N*2.5c to the publisher, so even
-- a 100% deposit-match bonus stays solvent (publisher cash <= real cash in).
-- The requestPayout action adds a system-wide pool backstop as belt-and-braces.
--
-- Apply via psql over the pooler (prod history diverged), not `db push`.

-- Per-campaign bid, in credits. v1 auction is first-price: highest bid wins and
-- is charged its bid. Defaults to the standard CPC so existing campaigns work.
alter table public.ad_campaigns
  add column if not exists bid_credits integer not null default 4 check (bid_credits > 0);

-- Promo/bonus ad credits, spent before paid credits and only on ad clicks.
alter table public.profiles
  add column if not exists ad_bonus_credits integer not null default 0;

-- Records how much bonus a given deposit granted (idempotency + audit).
alter table public.credit_purchases
  add column if not exists ad_bonus_credits integer not null default 0;

-- Rewrite the per-click charge:
--   * p_cpc_credits carries the winning BID (credits).
--   * spend bonus credits first, then paid credits (atomic, row-locked).
--   * publisher earns at the FLOOR rate (2.5c/credit), not rack.
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
  v_from_bonus int;
  v_from_paid int;
  v_slot_owner uuid;
  v_charged int;
  v_earn int;
  v_cut int;
  v_click uuid;
  v_rack_cents constant int := 5;    -- advertiser spend value per credit
  v_floor_cents constant numeric := 2.5; -- publisher cash-out value per credit
begin
  select owner_id, status, daily_budget_cents, spend_today_cents, spend_date
    into v_owner, v_status, v_daily, v_spend, v_date
  from public.ad_campaigns where id = p_campaign for update;
  if not found then return; end if;

  v_charged := p_cpc_credits * v_rack_cents;
  if v_date is distinct from current_date then v_spend := 0; end if;

  -- Not eligible (paused/exhausted or over daily budget): unbilled click.
  if v_status <> 'active' or (v_spend + v_charged) > v_daily then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false)
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  -- Debit advertiser: bonus credits first, then paid. Row-lock the profile.
  select credits_balance, coalesce(ad_bonus_credits, 0)
    into v_paid, v_bonus
  from public.profiles where id = v_owner for update;

  if coalesce(v_paid, 0) + coalesce(v_bonus, 0) < p_cpc_credits then
    update public.ad_campaigns set status = 'exhausted' where id = p_campaign;
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false)
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  v_from_bonus := least(v_bonus, p_cpc_credits);
  v_from_paid := p_cpc_credits - v_from_bonus;
  update public.profiles
    set ad_bonus_credits = ad_bonus_credits - v_from_bonus,
        credits_balance = credits_balance - v_from_paid
    where id = v_owner;

  -- Publisher earns at the floor rate; platform keeps the rest (incl. spread).
  v_earn := floor(p_cpc_credits * (1 - p_platform_rate) * v_floor_cents);
  v_cut := v_charged - v_earn;
  select owner_id into v_slot_owner from public.ad_slots where id = p_slot;

  update public.ad_campaigns
    set spend_today_cents = v_spend + v_charged,
        spend_date = current_date,
        total_spent_cents = coalesce(total_spent_cents,0) + v_charged
    where id = p_campaign;

  insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid)
    values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,v_charged,v_earn,v_cut,true)
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

-- Deposit-match promo: first completed deposit gets a 100% match in bonus ad
-- credits, capped at $100. Idempotent (records grant on the purchase row).
create or replace function public.ad_apply_deposit_bonus(p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_amount int;
  v_status text;
  v_already int;
  v_prior int;
  v_bonus int;
  v_match_rate constant numeric := 1.0;   -- 100% match
  v_max_cents constant int := 10000;       -- cap bonus at $100
  v_rack_cents constant int := 5;
begin
  select owner_id, amount_cents, status, coalesce(ad_bonus_credits, 0)
    into v_owner, v_amount, v_status, v_already
  from public.credit_purchases where coinpay_payment_id = p_payment_id for update;
  if not found or v_status <> 'complete' then return 0; end if;
  if v_already > 0 then return 0; end if; -- already granted

  -- First deposit only: any earlier completed purchase disqualifies.
  select count(*) into v_prior from public.credit_purchases
    where owner_id = v_owner and status = 'complete' and coinpay_payment_id <> p_payment_id;
  if v_prior > 0 then return 0; end if;

  v_bonus := floor(least(v_amount * v_match_rate, v_max_cents) / v_rack_cents);
  if v_bonus <= 0 then return 0; end if;

  update public.profiles
    set ad_bonus_credits = coalesce(ad_bonus_credits, 0) + v_bonus where id = v_owner;
  update public.credit_purchases
    set ad_bonus_credits = v_bonus where coinpay_payment_id = p_payment_id;
  return v_bonus;
end $$;

revoke execute on function public.ad_apply_deposit_bonus(text) from anon, authenticated;
grant execute on function public.ad_apply_deposit_bonus(text) to service_role;
