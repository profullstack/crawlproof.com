-- One CoinPay identity can be linked to several local accounts. Keep signup
-- creation unique per identity so simultaneous first logins converge; signed-in
-- connections are intentionally many-to-one.
alter table public.coinpay_identities
  drop constraint if exists coinpay_identities_coinpay_sub_key;

create index if not exists coinpay_identities_coinpay_sub_idx
  on public.coinpay_identities (coinpay_sub);

create unique index if not exists coinpay_identities_one_signup_per_sub_idx
  on public.coinpay_identities (coinpay_sub)
  where created_via = 'signup';

create or replace function public.uptime_user_id_by_coinpay_sub(p_sub text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.user_id
  from public.coinpay_identities i
  where i.coinpay_sub = p_sub
  order by i.created_at, i.user_id
  limit 1
$$;

notify pgrst, 'reload schema';
