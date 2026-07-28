-- Credentials for seed directories that sit behind a login.
--
-- Some directories worth seeding — trade association rosters, members-only
-- marketplaces — only show their listings to a signed-in visitor. Detection
-- (lib/outreach/loginWall.ts) can now tell that apart from an empty
-- directory; this is where the credential to get past it lives.
--
-- Scoped per host rather than per seed URL: a user has one account on a
-- directory, not one per search they paste in, and several seeds against the
-- same site should share it.
--
-- The password is only ever written to enc_password, AES-256-GCM via
-- lib/sp/vault.ts, with the key held in the app environment and never in the
-- database. There is deliberately no plaintext column to write to.

create table if not exists public.outreach_seed_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  -- Normalized, no scheme or www: matched against a seed URL's host.
  host text not null,
  username text not null,
  enc_password text not null,
  -- The page the login form was found on, so a retry doesn't have to guess.
  login_url text,
  -- Last time these credentials actually got us past the wall.
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One credential per host per org: a second one would be ambiguous at seed
-- time, and updating in place is what "change my password" should do.
create unique index if not exists outreach_seed_credentials_org_host_idx
  on public.outreach_seed_credentials(organization_id, host);

alter table public.outreach_seed_credentials enable row level security;

-- Read paths run on the service client after an explicit access check, the
-- same as the rest of the outreach tables. Owning the org is what grants
-- management, so a member cannot read another team's stored logins.
drop policy if exists "outreach_seed_credentials owner all"
  on public.outreach_seed_credentials;

create policy "outreach_seed_credentials owner all"
  on public.outreach_seed_credentials for all
  using ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));

drop trigger if exists outreach_seed_credentials_set_updated_at
  on public.outreach_seed_credentials;
create trigger outreach_seed_credentials_set_updated_at
  before update on public.outreach_seed_credentials
  for each row execute function public.lx_set_updated_at();

comment on table public.outreach_seed_credentials is
  'Per-host logins for seed directories behind a sign-in wall. Passwords are AES-256-GCM (lib/sp/vault.ts); the key lives in the app environment, never here.';

-- A campaign whose seed is gated is not failing, it is waiting on something
-- only the user can supply. Recording which hosts are waiting lets the UI say
-- so plainly, and offer the form that unblocks it, instead of leaving the
-- reason buried in an error string nobody reads.
alter table public.outreach_campaigns
  add column if not exists auth_required_hosts jsonb not null default '[]'::jsonb;

comment on column public.outreach_campaigns.auth_required_hosts is
  'Seed hosts that returned a sign-in wall and have no stored credential. Empty means nothing is waiting on the user.';
