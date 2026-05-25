-- API tokens for programmatic access to the social-posting v1 API.
-- Same user as sp_account; one user can mint many tokens (multiple
-- machines / CIs / external tools). Each token row stores ONLY the
-- SHA-256(token || pepper) hash — the plaintext token is shown to the
-- user once at creation time and never persisted.
--
-- Threat model: a DB leak alone does not expose any token (the
-- attacker needs SP_TOKEN_PEPPER too, which is application env).
-- Tokens themselves carry 256 bits of randomness, so brute-force
-- against the hash is computationally infeasible.

create table if not exists public.sp_api_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- Human-meaningful label ("sh1pt CLI on my laptop", "CI", …).
  name text not null,

  -- First 8 chars of the plaintext token, kept in the DB so the UI
  -- can disambiguate tokens without needing the secret.
  prefix text not null,

  -- Hex-encoded SHA-256(plaintext || SP_TOKEN_PEPPER).
  token_hash text not null,

  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Lookup path: bearer auth pulls a row by token_hash. Worth a unique
-- index — collisions would mean a duplicate token, which is its own
-- bug to surface.
create unique index if not exists sp_api_token_hash_unique
  on public.sp_api_token(token_hash);

create index if not exists sp_api_token_user_active_idx
  on public.sp_api_token(user_id)
  where revoked_at is null;

alter table public.sp_api_token enable row level security;

-- Owner can read + delete + revoke their own tokens; mint goes through
-- a server action that uses the user's session.
create policy "sp_api_token owner select"
  on public.sp_api_token for select
  using (auth.uid() = user_id);
create policy "sp_api_token owner insert"
  on public.sp_api_token for insert
  with check (auth.uid() = user_id);
create policy "sp_api_token owner update"
  on public.sp_api_token for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "sp_api_token owner delete"
  on public.sp_api_token for delete
  using (auth.uid() = user_id);
