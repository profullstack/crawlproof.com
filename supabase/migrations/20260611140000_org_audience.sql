-- Org-wide audience: connect each project's backing database (Supabase or
-- Turso), pull every user email into one deduped per-org list, and mass-email
-- that list through the org's existing sender config (SMTP or Resend).
--
-- Mirrors the patterns in 20260606133000_prospects_outreach_configs.sql:
-- RLS via public.is_org_owner, lx_set_updated_at trigger, and secrets held in
-- enc_* columns (encrypted by lib/sp/vault.ts; plaintext secret columns stay
-- null for new writes).

-- 1. Connected project databases ------------------------------------------

create table if not exists public.organization_data_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  label text not null,
  kind text not null check (kind in ('supabase', 'turso')),
  enabled boolean not null default true,
  -- Supabase
  supabase_url text,
  enc_service_role_key text,
  source_mode text check (source_mode in ('auth_users', 'table')),
  table_name text,
  email_column text,
  -- Turso (libSQL)
  turso_url text,
  enc_auth_token text,
  email_query text,
  -- Sync bookkeeping
  last_synced_at timestamptz,
  last_sync_count int,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organization_data_sources_org_idx
  on public.organization_data_sources(organization_id, enabled);

alter table public.organization_data_sources enable row level security;

drop policy if exists "organization_data_sources owner all"
  on public.organization_data_sources;
create policy "organization_data_sources owner all"
  on public.organization_data_sources for all
  using ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));

drop trigger if exists organization_data_sources_set_updated_at
  on public.organization_data_sources;
create trigger organization_data_sources_set_updated_at
  before update on public.organization_data_sources
  for each row execute function public.lx_set_updated_at();

-- 2. Deduped imported audience --------------------------------------------

create table if not exists public.organization_audience_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid references public.organization_data_sources(id) on delete set null,
  email text not null,
  unsubscribe_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  unsubscribed_at timestamptz,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive uniqueness per org so re-syncs upsert instead of dupe.
create unique index if not exists organization_audience_contacts_org_email_idx
  on public.organization_audience_contacts(organization_id, lower(email));

create index if not exists organization_audience_contacts_active_idx
  on public.organization_audience_contacts(organization_id)
  where unsubscribed_at is null;

alter table public.organization_audience_contacts enable row level security;

drop policy if exists "organization_audience_contacts owner all"
  on public.organization_audience_contacts;
create policy "organization_audience_contacts owner all"
  on public.organization_audience_contacts for all
  using ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));

drop trigger if exists organization_audience_contacts_set_updated_at
  on public.organization_audience_contacts;
create trigger organization_audience_contacts_set_updated_at
  before update on public.organization_audience_contacts
  for each row execute function public.lx_set_updated_at();

-- 3. Campaign audit log ----------------------------------------------------

create table if not exists public.organization_email_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  sender_config_id uuid references public.organization_outreach_configs(id) on delete set null,
  subject text not null,
  sent_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists organization_email_campaigns_org_idx
  on public.organization_email_campaigns(organization_id, created_at desc);

alter table public.organization_email_campaigns enable row level security;

drop policy if exists "organization_email_campaigns owner all"
  on public.organization_email_campaigns;
create policy "organization_email_campaigns owner all"
  on public.organization_email_campaigns for all
  using ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));
