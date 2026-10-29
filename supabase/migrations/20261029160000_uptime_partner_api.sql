-- Partner uptime API (/api/uptime/v1): first-party apps (w3bs.org,
-- threatcrush.com) manage a crawlproof user's monitors server to server.
-- Additive only.

-- 1. Partner tokens: cpu_ + 32 random bytes, only the sha256 (hex) is stored.
--    Minted with scripts/mint-uptime-partner.ts; the plaintext is printed once.
create table if not exists public.uptime_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.uptime_partners enable row level security;
revoke all on table public.uptime_partners from anon, authenticated;

-- 2. A user's one "Fleet" project: what every partner lists, so w3bs, threatcrush
--    and the crawlproof dashboard show the same monitors.
alter table public.projects add column if not exists kind text;
create unique index if not exists projects_one_fleet_per_owner
  on public.projects(owner_id) where kind = 'fleet';

-- 3. Per-user fleet settings: the logicsrc keyring share URL and the alert
--    defaults new fleet monitors get.
create table if not exists public.uptime_fleet_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  keys_url text,
  alert_email text,
  alert_phone text,
  updated_at timestamptz not null default now()
);
alter table public.uptime_fleet_settings enable row level security;
revoke all on table public.uptime_fleet_settings from anon, authenticated;

-- 4. Map a partner-asserted email to a crawlproof user with that CONFIRMED email.
create or replace function public.uptime_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u
   where lower(u.email) = lower(trim(p_email))
     and u.email_confirmed_at is not null
   order by u.created_at
   limit 1
$$;
revoke all on function public.uptime_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.uptime_user_id_by_email(text) to service_role;
