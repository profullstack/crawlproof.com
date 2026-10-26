-- Credit codes and invite bonuses land in the ONE balance crawlproof has:
-- profiles.credits_balance. @profullstack/redeem-credits keeps the codes
-- (sha256 only) and an audit row per redemption in credit_ledger; this table
-- is the idempotency key for writing those grants into the real balance.
--
-- source is `code:<codeId>` for a redeemed code and
-- `invite:<inviteId>:<inviter|invitee>` for an invite bonus. The primary key on
-- (user_id, source) is what makes a retried or concurrent mirror write a no-op,
-- so a code or an invite pays each person exactly once.

create table if not exists public.code_credit_grants (
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null,
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.code_credit_grants enable row level security;
revoke all on table public.code_credit_grants from anon, authenticated;

-- Insert the grant row; only if it is new, add the credits to the balance.
-- One statement each, in one function call, so both happen or neither does.
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

  update public.profiles pr
     set credits_balance = pr.credits_balance + p_credits
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
