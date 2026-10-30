-- Only verified provider receive addresses; never tokens or signing keys.
create table if not exists public.coinpay_wallet_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  coinpay_sub text not null,
  wallets jsonb not null default '[]'::jsonb check (jsonb_typeof(wallets) = 'array'),
  preferred_wallet_id text,
  synced_at timestamptz not null default now()
);
alter table public.coinpay_wallet_profiles enable row level security;
revoke all on public.coinpay_wallet_profiles from anon, authenticated;
grant all on public.coinpay_wallet_profiles to service_role;
notify pgrst, 'reload schema';
