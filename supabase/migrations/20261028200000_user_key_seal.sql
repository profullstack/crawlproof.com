-- Sealed keys (seal v2): every secret a user gives us is sealed to that user's
-- own key pair, whose private half opens only with their passphrase (or the
-- one-time recovery key). The server stores ciphertext + salt + KDF params +
-- key check + public key, nothing that opens it. See lib/sealed/crypto.ts.
--
-- Additive only. Legacy v1 blobs (SOCIAL_VAULT_KEY) stay in place until their
-- owner migrates them (lib/sealed/migrate.ts); "v2:" prefix = seal_version 2.

create table if not exists public.user_key_seal (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  -- null until the user sets a passphrase (a row may exist only to remember a nudge)
  seal jsonb,
  seal_version int not null default 2,
  -- one "your keys are locked" email per lock episode; cleared on unlock
  locked_nudged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_key_seal enable row level security;
-- Owners may read their own seal record (it is ciphertext + public key).
drop policy if exists "user_key_seal owner read" on public.user_key_seal;
create policy "user_key_seal owner read"
  on public.user_key_seal for select
  using (auth.uid() = user_id);
-- Writes go through the API (service role) only.

-- Operator keys (ours): COINPAY_API_KEY (payout scope), X402_PRIVATE_KEY.
-- Sealed to the admin who imported them; opened only while that admin is
-- unlocked. Service role only: no policies.
create table if not exists public.operator_sealed_secret (
  name text primary key,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  enc_value text not null check (enc_value like 'v2:%'),
  updated_at timestamptz not null default now()
);
alter table public.operator_sealed_secret enable row level security;

-- Unmigrated-row report (run by hand: select * from public.sealed_keys_status;)
create or replace view public.sealed_keys_status as
  select 'sp_account' as tbl, count(*) filter (where
      (enc_access_token is not null and enc_access_token not like 'v2:%')
   or (enc_refresh_token is not null and enc_refresh_token not like 'v2:%')
   or (enc_cookies is not null and enc_cookies not like 'v2:%')
   or (enc_username is not null and enc_username not like 'v2:%')
   or (enc_password is not null and enc_password not like 'v2:%')
   or (enc_2fa_seed is not null and enc_2fa_seed not like 'v2:%')
   or (enc_app_password is not null and enc_app_password not like 'v2:%')) as unmigrated,
   count(*) as total
  from public.sp_account
  union all
  select 'organization_outreach_configs', count(*) filter (where
      (enc_smtp_user is not null and enc_smtp_user not like 'v2:%')
   or (enc_smtp_pass is not null and enc_smtp_pass not like 'v2:%')
   or (enc_api_key is not null and enc_api_key not like 'v2:%')
   or (enc_auth_token is not null and enc_auth_token not like 'v2:%')
   or smtp_pass is not null or api_key is not null or auth_token is not null), count(*)
  from public.organization_outreach_configs
  union all
  select 'outreach_seed_credentials', count(*) filter (where enc_password not like 'v2:%'), count(*)
  from public.outreach_seed_credentials
  union all
  select 'integrations', count(*) filter (where
      encrypted_credentials ? 'api_token' and (encrypted_credentials->>'api_token') not like 'v2:%'), count(*)
  from public.integrations
  union all
  select 'user_key_seal (users with a passphrase)', count(*) filter (where seal is not null), count(*)
  from public.user_key_seal;

revoke all on public.sealed_keys_status from anon, authenticated;
