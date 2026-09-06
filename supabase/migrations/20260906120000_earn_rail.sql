-- The earn rail: value moving between parties on the network, where a party
-- is a person or an agent and either can pay either.
--
-- Why this is separate from ad_ledger. Ad money is advertiser -> publisher and
-- is governed by the credit solvency rules in 20260731120000_ad_solvency.sql:
-- a click may only accrue publisher cash from the cash-backed slice of the
-- credits that funded it, and after the publisher's 1.4c/credit there are ~0.35c
-- left per credit. There is no room in that spread to also pay the reader, and
-- paying them from it would recreate the exact bug that migration fixed —
-- non-cash-backed value becoming withdrawable cash.
--
-- So readers are not paid out of the click at all. They are paid out of what
-- the CRAWLERS pay: the x402 day passes sold by lib/crawl-gateway.ts, which
-- carry no publisher split and are close to pure margin. A fixed share of that
-- revenue funds a pool, and rewards are drawn from the pool and only from the
-- pool. That makes the whole rail solvent by construction rather than by
-- argument: total paid out <= total rewarded <= total funded <= cash collected
-- from crawlers. The pool balance is also the network-wide spend ceiling, so a
-- bot farm that beats every other control still cannot drain more than the
-- crawlers have already paid in.
--
-- Amounts are in MICROS (millionths of a dollar), not cents. A single ad read
-- is worth a small fraction of a cent, and cents round every one of them to
-- zero. Payouts convert to whole cents at withdrawal.

-- ─────────────────────────────────────────────────────────────────────────────
-- Accounts
-- ─────────────────────────────────────────────────────────────────────────────
-- A party on the rail. `human` is a signed-in person, keyed on their auth user.
-- `agent` is a bot, keyed on the API token it presents — one account per token,
-- so a single owner can run several agents with separate balances.
create table if not exists public.earn_accounts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('human','agent')),
  owner_id uuid references auth.users(id) on delete cascade,
  agent_token_id uuid references public.sp_api_token(id) on delete cascade,
  label text,
  payout_address text,
  payout_email text,
  status text not null default 'probation'
    check (status in ('probation','active','suspended')),
  -- Never negative: every debit path checks, and the constraint is the backstop.
  balance_micros bigint not null default 0 check (balance_micros >= 0),
  lifetime_earned_micros bigint not null default 0,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  -- A human account is keyed on the user, an agent account on the token, and
  -- exactly one of the two must be set.
  constraint earn_accounts_party check (
    (kind = 'human' and owner_id is not null and agent_token_id is null)
    or (kind = 'agent' and agent_token_id is not null)
  )
);
create unique index if not exists earn_accounts_owner_idx
  on public.earn_accounts(owner_id) where kind = 'human';
create unique index if not exists earn_accounts_token_idx
  on public.earn_accounts(agent_token_id) where agent_token_id is not null;
-- One payout address per account, network-wide: the cheapest way to make ten
-- sock-puppet accounts pointless is to make them share one wallet's caps.
create unique index if not exists earn_accounts_address_idx
  on public.earn_accounts(lower(payout_address)) where payout_address is not null;

comment on table public.earn_accounts is
  'A party on the earn rail. kind=human is keyed on auth.users, kind=agent on the sp_api_token it presents. balance_micros is withdrawable value in millionths of a dollar.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The pool
-- ─────────────────────────────────────────────────────────────────────────────
-- One row, forever. funded_micros only ever rises (crawler passes paid in),
-- rewarded_micros only ever rises (paid to accounts), and the difference is
-- what may still be rewarded. earn_award() refuses to overdraw it.
create table if not exists public.earn_pool (
  id boolean primary key default true check (id),
  funded_micros bigint not null default 0 check (funded_micros >= 0),
  rewarded_micros bigint not null default 0 check (rewarded_micros >= 0),
  updated_at timestamptz not null default now(),
  constraint earn_pool_solvent check (rewarded_micros <= funded_micros)
);
insert into public.earn_pool(id) values (true) on conflict (id) do nothing;

comment on table public.earn_pool is
  'Single row. Crawler pass revenue in, reader rewards out. The check constraint rewarded<=funded is the network-wide solvency guarantee and the hard spend ceiling.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Ledger
-- ─────────────────────────────────────────────────────────────────────────────
-- Every movement of value, in one place. from_account null means the pool
-- (funding and rewards); to_account null means the outside world (payouts).
create table if not exists public.earn_ledger (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('pool_funding','reward','transfer','payout','clawback')),
  from_account uuid references public.earn_accounts(id) on delete set null,
  to_account uuid references public.earn_accounts(id) on delete set null,
  amount_micros bigint not null check (amount_micros > 0),
  reason text,
  -- The external fact this row is the consequence of: a pass payment id, an
  -- engagement id, a payout id. Unique per kind, so a settlement notice that
  -- arrives twice funds the pool once.
  ref text,
  created_at timestamptz not null default now()
);
create unique index if not exists earn_ledger_ref_idx
  on public.earn_ledger(kind, ref) where ref is not null;
create index if not exists earn_ledger_to_idx on public.earn_ledger(to_account, created_at desc);
create index if not exists earn_ledger_from_idx on public.earn_ledger(from_account, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Engagements
-- ─────────────────────────────────────────────────────────────────────────────
-- Every attempt, accepted or not, with the reason it was refused. Refusals are
-- kept because "why am I not earning" is the first question a reader asks, and
-- because the refusal pattern is what a farm looks like.
create table if not exists public.earn_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.earn_accounts(id) on delete cascade,
  action text not null check (action in ('read','respond','follow')),
  campaign_id uuid references public.ad_campaigns(id) on delete set null,
  slot_id uuid references public.ad_slots(id) on delete set null,
  dwell_ms integer,
  ip_hash text,
  reward_micros bigint not null default 0 check (reward_micros >= 0),
  accepted boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists earn_events_account_day_idx
  on public.earn_events(account_id, created_at desc);
create index if not exists earn_events_ip_day_idx
  on public.earn_events(ip_hash, created_at desc) where ip_hash is not null;
-- One accepted reward per account per campaign per action per day. Farming the
-- same ad over and over is the obvious attack and this is the cheap answer.
--
-- The day is pinned to UTC rather than written `created_at::date`. Casting a
-- timestamptz to date is STABLE, not IMMUTABLE — it reads the session's
-- TimeZone — and Postgres refuses to build an index on it. Shifting to UTC
-- first yields a plain timestamp, whose cast to date is immutable. The
-- counting queries in earn_award() use the same UTC boundary so the index and
-- the caps agree about when a day ends.
create unique index if not exists earn_events_once_per_day_idx
  on public.earn_events(
    account_id, campaign_id, action, (((created_at at time zone 'UTC'))::date))
  where accepted and campaign_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Payouts
-- ─────────────────────────────────────────────────────────────────────────────
-- Separate from ad_payouts, which is keyed on auth.users and cannot express an
-- agent. Cents, not micros: this is the boundary where value leaves for CoinPay.
create table if not exists public.earn_payouts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.earn_accounts(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USDC_POL',
  address text not null,
  status text not null default 'requested'
    check (status in ('requested','sent','confirmed','failed')),
  coinpay_payout_id text,
  tx_hash text,
  last_error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists earn_payouts_account_idx on public.earn_payouts(account_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS. Service role writes everything; a signed-in person may read their own.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.earn_accounts enable row level security;
alter table public.earn_ledger   enable row level security;
alter table public.earn_events   enable row level security;
alter table public.earn_payouts  enable row level security;
alter table public.earn_pool     enable row level security;

drop policy if exists "own earn account" on public.earn_accounts;
create policy "own earn account" on public.earn_accounts
  for select using (owner_id = auth.uid());

drop policy if exists "own earn events" on public.earn_events;
create policy "own earn events" on public.earn_events
  for select using (exists (
    select 1 from public.earn_accounts a
     where a.id = earn_events.account_id and a.owner_id = auth.uid()));

drop policy if exists "own earn payouts" on public.earn_payouts;
create policy "own earn payouts" on public.earn_payouts
  for select using (exists (
    select 1 from public.earn_accounts a
     where a.id = earn_payouts.account_id and a.owner_id = auth.uid()));

drop policy if exists "own earn ledger" on public.earn_ledger;
create policy "own earn ledger" on public.earn_ledger
  for select using (exists (
    select 1 from public.earn_accounts a
     where (a.id = earn_ledger.to_account or a.id = earn_ledger.from_account)
       and a.owner_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- earn_fund_pool: crawler money in.
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotent on p_ref, because a settlement notice is a reason to record the
-- money, not proof it has not already been recorded.
create or replace function public.earn_fund_pool(
  p_amount_micros bigint,
  p_ref text,
  p_reason text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available bigint;
begin
  if p_amount_micros is null or p_amount_micros <= 0 then
    raise exception 'earn_fund_pool: amount must be positive';
  end if;

  insert into public.earn_ledger(kind, amount_micros, reason, ref)
  values ('pool_funding', p_amount_micros, p_reason, p_ref)
  on conflict (kind, ref) where ref is not null do nothing;

  if not found then
    -- Already recorded under this ref. Report the balance, change nothing.
    select funded_micros - rewarded_micros into v_available from public.earn_pool where id;
    return v_available;
  end if;

  update public.earn_pool
     set funded_micros = funded_micros + p_amount_micros,
         updated_at = now()
   where id
  returning funded_micros - rewarded_micros into v_available;

  return v_available;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- earn_award: one engagement, all the gates, atomically.
-- ─────────────────────────────────────────────────────────────────────────────
-- Every limit is enforced here rather than in the caller, because the caller is
-- reachable from a browser and this is not. Order matters: the cheap identity
-- checks first, the counting queries last.
create or replace function public.earn_award(
  p_account uuid,
  p_action text,
  p_reward_micros bigint,
  p_campaign uuid,
  p_slot uuid,
  p_ip_hash text,
  p_dwell_ms integer,
  p_min_dwell_ms integer,
  p_daily_event_cap integer,
  p_daily_micros_cap bigint
) returns table (event_id uuid, reward_micros bigint, accepted boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_reason text;
  v_award bigint := 0;
  v_available bigint;
  v_today_events integer;
  v_today_micros bigint;
  v_ip_micros bigint;
  v_event uuid;
  -- The same UTC day the once-per-campaign index is built on, so the caps and
  -- the index cannot disagree about when today started.
  v_day_start constant timestamptz :=
    date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  select status into v_status from public.earn_accounts where id = p_account for update;
  if v_status is null then
    raise exception 'earn_award: no such account';
  end if;

  if v_status = 'suspended' then
    v_reason := 'account suspended';
  elsif p_action = 'read' and coalesce(p_dwell_ms, 0) < coalesce(p_min_dwell_ms, 0) then
    -- A view is not a read. Paying for the impression is what makes a farm
    -- worth building, so the unit has to have actually been in front of
    -- somebody for a while.
    v_reason := 'too brief to count';
  else
    -- Today's take for this account, and for whatever address this account is
    -- reachable at. The IP cap is shared across every account behind it, so
    -- twenty accounts on one machine earn what one account would.
    -- Aliased and qualified throughout. `reward_micros` and `accepted` are
    -- both columns of earn_events AND output columns of this function, and
    -- plpgsql refuses the ambiguity at run time rather than at creation — so
    -- an unqualified version of this query applies cleanly and then fails on
    -- the first real call.
    select count(*), coalesce(sum(e.reward_micros), 0)
      into v_today_events, v_today_micros
      from public.earn_events e
     where e.account_id = p_account and e.accepted
       and e.created_at >= v_day_start;

    if v_today_events >= coalesce(p_daily_event_cap, 0) then
      v_reason := 'daily limit reached';
    elsif v_today_micros >= coalesce(p_daily_micros_cap, 0) then
      v_reason := 'daily limit reached';
    else
      if p_ip_hash is not null then
        select coalesce(sum(e.reward_micros), 0) into v_ip_micros
          from public.earn_events e
         where e.ip_hash = p_ip_hash and e.accepted
           and e.created_at >= v_day_start;
        if v_ip_micros >= coalesce(p_daily_micros_cap, 0) then
          v_reason := 'daily limit reached for this connection';
        end if;
      end if;

      if v_reason is null then
        -- Never more than the pool holds, and never more than today's headroom.
        select funded_micros - rewarded_micros into v_available
          from public.earn_pool where id for update;
        v_award := least(
          p_reward_micros,
          coalesce(p_daily_micros_cap, 0) - v_today_micros,
          coalesce(v_available, 0)
        );
        if v_award <= 0 then
          v_award := 0;
          v_reason := 'the reward pool is empty right now';
        end if;
      end if;
    end if;
  end if;

  begin
    insert into public.earn_events(
      account_id, action, campaign_id, slot_id, dwell_ms, ip_hash,
      reward_micros, accepted, reason)
    values (
      p_account, p_action, p_campaign, p_slot, p_dwell_ms, p_ip_hash,
      case when v_reason is null then v_award else 0 end,
      v_reason is null,
      v_reason)
    returning id into v_event;
  exception when unique_violation then
    -- The once-per-campaign-per-day index. Record nothing, refuse politely.
    return query select null::uuid, 0::bigint, false, 'already rewarded for this one today'::text;
    return;
  end;

  if v_reason is null then
    update public.earn_pool
       set rewarded_micros = rewarded_micros + v_award, updated_at = now()
     where id;
    update public.earn_accounts
       set balance_micros = balance_micros + v_award,
           lifetime_earned_micros = lifetime_earned_micros + v_award
     where id = p_account;
    insert into public.earn_ledger(kind, to_account, amount_micros, reason, ref)
    values ('reward', p_account, v_award, p_action, v_event::text);
  end if;

  return query select v_event, case when v_reason is null then v_award else 0::bigint end,
                      v_reason is null, v_reason;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- earn_transfer: any party pays any party.
-- ─────────────────────────────────────────────────────────────────────────────
-- Human to agent, agent to agent, agent to human. The rail does not care which,
-- and deliberately so: an agent paying another agent for a summary is the same
-- movement as a reader tipping a bot that wrote something useful. Touches no
-- pool balance, so it can never affect solvency — it only moves value that has
-- already been funded.
create or replace function public.earn_transfer(
  p_from uuid,
  p_to uuid,
  p_amount_micros bigint,
  p_reason text default null,
  p_ref text default null
) returns table (ledger_id uuid, from_balance bigint, to_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_balance bigint;
  v_to_status text;
  v_ledger uuid;
  v_to_balance bigint;
begin
  if p_amount_micros is null or p_amount_micros <= 0 then
    raise exception 'earn_transfer: amount must be positive';
  end if;
  if p_from = p_to then
    raise exception 'earn_transfer: an account cannot pay itself';
  end if;

  -- Lock in a stable order so two transfers between the same pair cannot
  -- deadlock each other.
  perform 1 from public.earn_accounts
   where id in (p_from, p_to) order by id for update;

  select balance_micros into v_from_balance from public.earn_accounts where id = p_from;
  if v_from_balance is null then
    raise exception 'earn_transfer: no such payer';
  end if;
  select status into v_to_status from public.earn_accounts where id = p_to;
  if v_to_status is null then
    raise exception 'earn_transfer: no such payee';
  end if;
  if v_to_status = 'suspended' then
    raise exception 'earn_transfer: that account cannot be paid';
  end if;
  if v_from_balance < p_amount_micros then
    raise exception 'earn_transfer: not enough balance';
  end if;

  update public.earn_accounts
     set balance_micros = balance_micros - p_amount_micros
   where id = p_from
  returning balance_micros into v_from_balance;

  update public.earn_accounts
     set balance_micros = balance_micros + p_amount_micros
   where id = p_to
  returning balance_micros into v_to_balance;

  insert into public.earn_ledger(kind, from_account, to_account, amount_micros, reason, ref)
  values ('transfer', p_from, p_to, p_amount_micros, p_reason, p_ref)
  returning id into v_ledger;

  return query select v_ledger, v_from_balance, v_to_balance;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- earn_request_payout: value leaves the rail.
-- ─────────────────────────────────────────────────────────────────────────────
-- Debits the balance as the row is written, so two requests in flight cannot
-- both be funded. A failed send puts it back; that is the caller's job and
-- earn_fail_payout below is how.
create or replace function public.earn_request_payout(
  p_account uuid,
  p_amount_cents integer,
  p_currency text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_micros bigint := p_amount_cents::bigint * 10000;
  v_balance bigint;
  v_status text;
  v_address text;
  v_payout uuid;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'earn_request_payout: amount must be positive';
  end if;

  select balance_micros, status, payout_address
    into v_balance, v_status, v_address
    from public.earn_accounts where id = p_account for update;
  if v_balance is null then
    raise exception 'earn_request_payout: no such account';
  end if;
  if v_status <> 'active' then
    -- Probation accrues but cannot withdraw. A farm that has to wait is a farm
    -- with a cost, and the wait is where most of them stop.
    raise exception 'earn_request_payout: this account cannot withdraw yet';
  end if;
  if v_address is null then
    raise exception 'earn_request_payout: no payout address on this account';
  end if;
  if v_balance < v_micros then
    raise exception 'earn_request_payout: not enough balance';
  end if;

  update public.earn_accounts
     set balance_micros = balance_micros - v_micros
   where id = p_account;

  insert into public.earn_payouts(account_id, amount_cents, currency, address)
  values (p_account, p_amount_cents, coalesce(p_currency, 'USDC_POL'), v_address)
  returning id into v_payout;

  insert into public.earn_ledger(kind, from_account, amount_micros, reason, ref)
  values ('payout', p_account, v_micros, 'withdrawal', v_payout::text);

  return v_payout;
end;
$$;

-- A send that did not happen. Puts the money back where it came from.
create or replace function public.earn_fail_payout(
  p_payout uuid,
  p_error text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account uuid;
  v_cents integer;
begin
  select account_id, amount_cents into v_account, v_cents
    from public.earn_payouts where id = p_payout and status = 'requested' for update;
  if v_account is null then
    return;
  end if;
  update public.earn_payouts
     set status = 'failed', last_error = left(coalesce(p_error, ''), 500), settled_at = now()
   where id = p_payout;
  update public.earn_accounts
     set balance_micros = balance_micros + (v_cents::bigint * 10000)
   where id = v_account;
  insert into public.earn_ledger(kind, to_account, amount_micros, reason, ref)
  values ('clawback', v_account, v_cents::bigint * 10000, 'payout failed', p_payout::text || ':failed');
end;
$$;

revoke all on function public.earn_fund_pool(bigint, text, text) from public, anon, authenticated;
revoke all on function public.earn_award(uuid, text, bigint, uuid, uuid, text, integer, integer, integer, bigint) from public, anon, authenticated;
revoke all on function public.earn_transfer(uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.earn_request_payout(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.earn_fail_payout(uuid, text) from public, anon, authenticated;
