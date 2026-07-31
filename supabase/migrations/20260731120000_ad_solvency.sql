-- Ad network — Phase 5: make the marketplace solvent.
--
-- The bug: free credits were convertible into real withdrawable cash.
--
-- Phase 4 argued solvency from a rack↔floor spread: advertisers spend credits
-- valued at 5c, publishers cash out at 2.5c, so 0.7*N*2.5c <= N*5c and payouts
-- can never exceed cash in. That argument assumes every credit was SOLD at
-- rack. Two things break the assumption:
--
--   1. Signup grants. profiles.credits_balance defaults to 20 free credits
--      (60 before 20260608010000), and admin grants add more. These cost a user
--      nothing, are indistinguishable from purchased credits once in the
--      balance, and each one obligated 0.7*2.5c = 1.75c of real USDC the moment
--      it was spent on a click. At the time of writing: 16,454 credits
--      outstanding against $12.00 of lifetime deposits — ~$288 of liability at
--      4% coverage.
--   2. Volume packs. The 100-scan pack sells credits at 2.5c, exactly the
--      publisher floor, so the "2:1 spread" is 1:1 on the deepest tier. Layer
--      the 100% deposit match on top (granted at rack regardless of what the
--      buyer actually paid per credit) and cash in per credit falls to 1.67c
--      against 1.75c out — structurally insolvent.
--
-- The fix, in four parts:
--   A. Credit provenance. profiles.promo_credits tracks the non-cash-backed
--      slice of credits_balance. Clicks funded by promo credits still bill the
--      advertiser and still count as valid delivery — they just accrue nothing
--      to the publisher, because there is no cash behind them to pay out.
--   B. Self-dealing block. A click never earns when the slot owner and the
--      campaign owner are the same account.
--   C. Payout floor 2.5c -> 2.0c (publisher earns 1.4c/credit), and the deposit
--      match is capped so post-match cash in per credit never drops below
--      1.75c — a 25% margin over the payout rate on every pack.
--   D. A database-level solvency invariant on ad_payouts, so the guard survives
--      anything that writes a payout without going through the server action.
--
-- Apply via psql over the pooler (prod history diverged), not `db push`.

-- ---------------------------------------------------------------------------
-- A. Credit provenance
-- ---------------------------------------------------------------------------

-- The portion of credits_balance that was granted rather than bought. Spent
-- before cash-backed credits, and never accrues publisher cash.
--
-- Default matches the signup grant in 20260608010000 so a new profile row is
-- born fully promo-funded; credit_purchase_complete adds to credits_balance
-- without touching this column, so purchased credits are cash-backed by
-- construction.
alter table public.profiles
  add column if not exists promo_credits integer not null default 20;

-- Backfill: a user's cash-backed credits can never exceed what they have
-- actually bought, so everything above that is promo. Conservative in the safe
-- direction — it can over-count promo (a user who spent grants on scans looks
-- more promo-funded than they are), which under-accrues publisher cash rather
-- than over-accruing it.
update public.profiles p
set promo_credits = greatest(
  0,
  p.credits_balance - coalesce((
    select sum(cp.credits_added)
    from public.credit_purchases cp
    where cp.owner_id = p.id and cp.status = 'complete'
  ), 0)
);

comment on column public.profiles.promo_credits is
  'Non-cash-backed slice of credits_balance (signup + admin grants). Spent before cash-backed credits; ad clicks funded from it accrue no publisher payout. Always read as least(promo_credits, credits_balance) — other debit paths do not decrement it, and that drift is deliberately conservative.';

-- ---------------------------------------------------------------------------
-- B + C. Charge a click: self-deal block, provenance-aware accrual
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
  v_rack_cents constant int := 5;        -- advertiser spend value per credit
  v_floor_cents constant numeric := 2.0; -- publisher cash-out value per credit
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

  select owner_id into v_slot_owner from public.ad_slots where id = p_slot;

  -- Self-dealing: clicking your own ad on your own slot moves credits into
  -- withdrawable cash for free. Bill nobody, earn nobody. Checked before the
  -- debit so a self-click doesn't even consume the advertiser's budget.
  if v_slot_owner is not null and v_slot_owner = v_owner then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false)
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  -- Debit advertiser. Row-lock the profile. Spend order is cheapest-to-us
  -- first: deposit-match bonus, then promo grants, then cash-backed credits.
  select credits_balance,
         coalesce(ad_bonus_credits, 0),
         least(coalesce(promo_credits, 0), credits_balance)
    into v_paid, v_bonus, v_promo
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
  v_rest := p_cpc_credits - v_from_bonus;
  v_from_promo := least(v_promo, v_rest);
  v_from_cash := v_rest - v_from_promo;

  update public.profiles
    set ad_bonus_credits = ad_bonus_credits - v_from_bonus,
        credits_balance = credits_balance - (v_from_promo + v_from_cash),
        promo_credits = greatest(0, coalesce(promo_credits, 0) - v_from_promo)
    where id = v_owner;

  -- Publisher earns at the floor rate, and ONLY on the cash-backed slice of
  -- the click. Bonus and promo credits bill the advertiser (so budgets and
  -- reporting stay honest) but carry no cash behind them, so they obligate
  -- nothing. The platform keeps the remainder, including the rack↔floor spread.
  v_earn := floor(v_from_cash * (1 - p_platform_rate) * v_floor_cents);
  v_cut := v_charged - v_earn;

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

-- ---------------------------------------------------------------------------
-- C. Deposit match, capped for solvency
-- ---------------------------------------------------------------------------

-- The old grant was floor(amount_cents / 5) — denominated at rack regardless of
-- what the buyer actually paid per credit, so a 2.5c/credit pack got matched at
-- 200% of the credits bought. Now: a true 100% match of credits purchased,
-- capped so that amount_cents / (credits_added + bonus) never falls below
-- 1.75c, a 25% margin over the 1.4c publisher payout rate.
create or replace function public.ad_apply_deposit_bonus(p_payment_id text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_amount int;
  v_credits int;
  v_status text;
  v_already int;
  v_prior int;
  v_bonus int;
  v_cap int;
  v_match_rate constant numeric := 1.0;          -- 100% match of credits bought
  v_max_cents constant int := 10000;             -- cap bonus value at $100 rack
  v_rack_cents constant int := 5;
  v_min_cash_per_credit constant numeric := 1.75; -- solvency floor, in cents
begin
  select owner_id, amount_cents, credits_added, status, coalesce(ad_bonus_credits, 0)
    into v_owner, v_amount, v_credits, v_status, v_already
  from public.credit_purchases where coinpay_payment_id = p_payment_id for update;
  if not found or v_status <> 'complete' then return 0; end if;
  if v_already > 0 then return 0; end if; -- already granted

  -- First deposit only: any earlier completed purchase disqualifies.
  select count(*) into v_prior from public.credit_purchases
    where owner_id = v_owner and status = 'complete' and coinpay_payment_id <> p_payment_id;
  if v_prior > 0 then return 0; end if;

  -- Solvency cap: the most bonus credits this deposit can carry and still leave
  -- at least v_min_cash_per_credit of real cash behind every credit granted.
  v_cap := greatest(0, floor(v_amount / v_min_cash_per_credit)::int - v_credits);

  v_bonus := least(
    floor(v_credits * v_match_rate)::int,        -- 100% of what they bought
    floor(v_max_cents / v_rack_cents)::int,      -- $100 of rack value
    v_cap                                        -- solvency
  );
  if v_bonus <= 0 then return 0; end if;

  update public.profiles
    set ad_bonus_credits = coalesce(ad_bonus_credits, 0) + v_bonus where id = v_owner;
  update public.credit_purchases
    set ad_bonus_credits = v_bonus where coinpay_payment_id = p_payment_id;
  return v_bonus;
end $$;

revoke execute on function public.ad_apply_deposit_bonus(text) from anon, authenticated;
grant execute on function public.ad_apply_deposit_bonus(text) to service_role;

-- ---------------------------------------------------------------------------
-- D. Database-level solvency invariant
-- ---------------------------------------------------------------------------

-- Cumulative publisher payouts can never exceed cumulative real advertiser cash
-- in. requestPayout() checks this too, but the check belongs where it cannot be
-- bypassed: any path that inserts an ad_payouts row is now covered.
create or replace function public.ad_payout_solvency_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cash_in bigint;
  v_paid_out bigint;
begin
  if new.status = 'failed' then return new; end if;

  select coalesce(sum(amount_cents), 0) into v_cash_in
    from public.credit_purchases where status = 'complete';

  select coalesce(sum(amount_cents), 0) into v_paid_out
    from public.ad_payouts where status <> 'failed' and id <> new.id;

  if v_paid_out + new.amount_cents > v_cash_in then
    raise exception 'ad payout would exceed platform cash in (requested %c, already paid %c, cash in %c)',
      new.amount_cents, v_paid_out, v_cash_in
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists ad_payout_solvency on public.ad_payouts;
create trigger ad_payout_solvency
  before insert or update of amount_cents, status on public.ad_payouts
  for each row execute function public.ad_payout_solvency_guard();
