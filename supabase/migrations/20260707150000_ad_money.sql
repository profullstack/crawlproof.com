-- Ad network — Phase 3: money movement.
--
-- Advertiser budget rides the existing credits system (1 credit = 5¢, atomic
-- consume_credit). Each valid click debits the advertiser, accrues the
-- publisher's share into ad_ledger, and records the platform cut. Daily budget
-- pacing lives on ad_campaigns. Publisher withdrawals land in ad_payouts;
-- outbound CoinPay execution is wired separately (coinpayportal has a crypto
-- payouts service — see docs/ad-network-prd.md).
--
-- Apply via psql over the pooler (prod history diverged), not `db push`.

-- Daily-budget pacing + lifetime spend on campaigns.
alter table public.ad_campaigns
  add column if not exists spend_today_cents integer not null default 0,
  add column if not exists spend_date date,
  add column if not exists total_spent_cents integer not null default 0;

-- Publisher earnings ledger (double-entry-ish). owner_id null = the platform.
create table if not exists public.ad_ledger (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('publisher_accrual','platform_fee','publisher_payout','refund')),
  owner_id uuid references auth.users(id) on delete set null,
  campaign_id uuid references public.ad_campaigns(id) on delete set null,
  slot_id uuid references public.ad_slots(id) on delete set null,
  amount_cents integer not null,
  currency text,
  ref_click_id uuid references public.ad_clicks(id) on delete set null,
  coinpay_payment_id text,
  tx_hash text,
  created_at timestamptz not null default now()
);
create index if not exists ad_ledger_owner_idx on public.ad_ledger(owner_id, kind);
create index if not exists ad_ledger_slot_idx on public.ad_ledger(slot_id);

-- Outbound crypto withdrawals to publishers.
create table if not exists public.ad_payouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid references public.ad_slots(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null,
  address text not null,
  status text not null default 'requested'
    check (status in ('requested','sent','confirmed','failed')),
  coinpay_payout_id text,
  tx_hash text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists ad_payouts_owner_idx on public.ad_payouts(owner_id, status);
create index if not exists ad_payouts_slot_idx on public.ad_payouts(slot_id);

alter table public.ad_ledger enable row level security;
alter table public.ad_payouts enable row level security;

drop policy if exists "read own ledger" on public.ad_ledger;
create policy "read own ledger" on public.ad_ledger
  for select using (owner_id = auth.uid());

drop policy if exists "own payouts" on public.ad_payouts;
create policy "own payouts" on public.ad_payouts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Atomic per-click charge. Locks the campaign, enforces daily budget + funds,
-- debits advertiser credits, records the click with cents, and accrues the
-- publisher share + platform fee. Returns the click row's money outcome.
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
  v_slot_owner uuid;
  v_charged int;
  v_earn int;
  v_cut int;
  v_click uuid;
  v_credit_cents constant int := 5;
begin
  select owner_id, status, daily_budget_cents, spend_today_cents, spend_date
    into v_owner, v_status, v_daily, v_spend, v_date
  from public.ad_campaigns where id = p_campaign for update;
  if not found then return; end if;

  v_charged := p_cpc_credits * v_credit_cents;
  if v_date is distinct from current_date then v_spend := 0; end if;

  -- Not eligible (paused/exhausted or over daily budget): record an unbilled click.
  if v_status <> 'active' or (v_spend + v_charged) > v_daily then
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false)
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  -- Debit advertiser credits atomically; pause + record unbilled if broke.
  if not public.consume_credit(v_owner, p_cpc_credits) then
    update public.ad_campaigns set status = 'exhausted' where id = p_campaign;
    insert into public.ad_clicks(impression_id,slot_id,campaign_id,creative_id,visitor_id,ip_hash,geo_country,device,charged_cents,publisher_earn_cents,platform_cut_cents,valid)
      values (p_impression,p_slot,p_campaign,p_creative,p_visitor,p_ip_hash,p_country,p_device,0,0,0,false)
      returning id into v_click;
    return query select v_click, 0, 0, false;
    return;
  end if;

  v_earn := floor(v_charged * (1 - p_platform_rate));
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
