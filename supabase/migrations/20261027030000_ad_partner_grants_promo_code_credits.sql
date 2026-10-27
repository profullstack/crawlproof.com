-- Credit that nobody paid for must never turn into publisher cash.
--
-- ad_charge_click pays a publisher only from the cash-backed part of an
-- advertiser's balance: profiles.promo_credits is the non-cash slice of
-- credits_balance (read as least(promo_credits, credits_balance)) and
-- profiles.ad_bonus_credits is ad-only bonus credit; clicks funded from either
-- accrue no publisher payout (20260731120000_ad_solvency, 20260818120000).
--
-- 1. grant_code_credits (credit codes + invite bonuses, 20261026180200) added
--    to credits_balance only, so a redeemed code bought ad clicks that paid a
--    publisher real crypto: money out that no deposit backed. It now adds the
--    same amount to promo_credits, like the admin grant does. No backfill: on
--    2026-10-27 code_credit_grants had 0 rows.
--
-- 2. Ad credit a partner (ad.network) hands its own users, e.g. a credit code
--    redeemed on ad.network, lands as ad_bonus_credits on the partner account,
--    once per (partner, reference): spend-only, never withdrawable, and it pays
--    no publisher. The partner keeps the per-person split, as it does for deposits.

create or replace function public.grant_code_credits(p_user uuid, p_source text, p_credits integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if p_credits is null or p_credits < 1 or p_credits > 100000 then
    raise exception 'grant_code_credits: credits out of range (%)', p_credits;
  end if;
  if p_source is null or length(p_source) = 0 or length(p_source) > 200 then
    raise exception 'grant_code_credits: bad source';
  end if;

  insert into public.code_credit_grants (user_id, source, credits)
  values (p_user, p_source, p_credits)
  on conflict (user_id, source) do nothing;

  if not found then
    select pr.credits_balance into v_balance from public.profiles pr where pr.id = p_user;
    return jsonb_build_object('applied', false, 'balance', v_balance);
  end if;

  -- promo_credits: these credits are not cash-backed (see header).
  update public.profiles pr
     set credits_balance = pr.credits_balance + p_credits,
         promo_credits = coalesce(pr.promo_credits, 0) + p_credits
   where pr.id = p_user
  returning pr.credits_balance into v_balance;

  if v_balance is null then
    raise exception 'grant_code_credits: no profile for %', p_user;
  end if;

  return jsonb_build_object('applied', true, 'balance', v_balance);
end;
$$;

revoke all on function public.grant_code_credits(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.grant_code_credits(uuid, text, integer) to service_role;

create table if not exists public.ad_partner_grants (
  partner_id uuid not null references public.profiles(id) on delete cascade,
  reference text not null check (length(reference) between 1 and 200),
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now(),
  primary key (partner_id, reference)
);

alter table public.ad_partner_grants enable row level security;
revoke all on table public.ad_partner_grants from anon, authenticated;

create or replace function public.ad_partner_grant(p_partner uuid, p_reference text, p_credits integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bonus integer;
begin
  if p_credits is null or p_credits < 1 or p_credits > 100000 then
    raise exception 'ad_partner_grant: credits out of range (%)', p_credits;
  end if;
  if p_reference is null or length(p_reference) = 0 or length(p_reference) > 200 then
    raise exception 'ad_partner_grant: bad reference';
  end if;

  insert into public.ad_partner_grants (partner_id, reference, credits)
  values (p_partner, p_reference, p_credits)
  on conflict (partner_id, reference) do nothing;

  if not found then
    select pr.ad_bonus_credits into v_bonus from public.profiles pr where pr.id = p_partner;
    return jsonb_build_object('applied', false, 'ad_bonus_credits', v_bonus,
      'credits', (select g.credits from public.ad_partner_grants g where g.partner_id = p_partner and g.reference = p_reference));
  end if;

  update public.profiles pr
     set ad_bonus_credits = coalesce(pr.ad_bonus_credits, 0) + p_credits
   where pr.id = p_partner
  returning pr.ad_bonus_credits into v_bonus;

  if v_bonus is null then
    raise exception 'ad_partner_grant: no profile for %', p_partner;
  end if;

  return jsonb_build_object('applied', true, 'ad_bonus_credits', v_bonus, 'credits', p_credits);
end;
$$;

revoke all on function public.ad_partner_grant(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.ad_partner_grant(uuid, text, integer) to service_role;
