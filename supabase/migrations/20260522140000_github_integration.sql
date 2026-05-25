-- GitHub App integration: store one row per GitHub installation a user has
-- authorized. We don't store individual repos — Crawlproof asks the GitHub
-- API for the live list on demand (the install scope is the source of
-- truth, and users add/remove repos on github.com without telling us).

create table if not exists public.github_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- GitHub's numeric installation id.
  installation_id bigint not null,
  -- Account this installation belongs to. Usually the user's GitHub
  -- account, but can be an organization too (the user is just the
  -- installer of record).
  account_login text not null,
  account_type text not null check (account_type in ('User', 'Organization')),
  account_id bigint not null,
  -- Cached installation token. Lives in github.com for one hour; we
  -- refresh on demand and rewrite this row.
  access_token text,
  access_token_expires_at timestamptz,
  -- Tracks suspended / removed installations so the UI shows the right
  -- reconnect prompt.
  suspended_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id)
);

create index if not exists github_installations_user_idx
  on public.github_installations(user_id) where removed_at is null;

alter table public.github_installations enable row level security;

create policy "github_installations owner select"
  on public.github_installations for select
  using (auth.uid() = user_id);

-- Service role writes (via /api/github/callback) — no INSERT/UPDATE
-- policies needed for end users. Owners can remove their own connection.
create policy "github_installations owner delete"
  on public.github_installations for delete
  using (auth.uid() = user_id);
