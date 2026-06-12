-- Audience Hub: centralized, deduplicated, consent-aware contacts across all
-- connected properties. Browser events arrive via /api/track (stats.js);
-- trusted lifecycle events arrive via POST /api/events with a per-project
-- bearer key (hashed at rest, mirroring lib/sp/apiToken.ts).
--
-- Scoping: contacts dedupe at the account level — the organization when the
-- source project belongs to one, otherwise the project owner. Distinct from
-- organization_audience_contacts (the mass-email import list); these tables
-- are the event-driven audience graph from the PRD.

-- 1. Contacts ----------------------------------------------------------------

create table if not exists public.audience_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  email text not null,
  normalized_email text not null,
  name text,
  status text not null default 'lead'
    check (status in ('unknown', 'lead', 'subscriber', 'user', 'customer', 'unsubscribed', 'suppressed', 'deleted')),
  marketing_consent boolean not null default false,
  unsubscribed_at timestamptz,
  suppressed_at timestamptz,
  suppression_reason text,
  source_project_id uuid references public.projects(id) on delete set null,
  -- First/last-touch attribution (PRD §18).
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  first_url text,
  first_referrer text,
  first_utm_source text,
  first_utm_medium text,
  first_utm_campaign text,
  last_url text,
  last_referrer text,
  last_utm_source text,
  last_utm_medium text,
  last_utm_campaign text,
  tags jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (owner_id is not null or organization_id is not null)
);

-- Dedupe key: one contact per normalized email per scope. Org-scoped and
-- personal-scoped contacts live side by side, so two partial indexes.
create unique index if not exists audience_contacts_org_email_idx
  on public.audience_contacts(organization_id, normalized_email)
  where organization_id is not null;
create unique index if not exists audience_contacts_owner_email_idx
  on public.audience_contacts(owner_id, normalized_email)
  where organization_id is null;
create index if not exists audience_contacts_owner_idx
  on public.audience_contacts(owner_id, last_seen_at desc);
create index if not exists audience_contacts_org_idx
  on public.audience_contacts(organization_id, last_seen_at desc);

alter table public.audience_contacts enable row level security;

drop policy if exists "audience_contacts owner select" on public.audience_contacts;
create policy "audience_contacts owner select"
  on public.audience_contacts for select
  using (
    owner_id = auth.uid()
    or (organization_id is not null and (select public.is_org_owner(organization_id, auth.uid())))
  );

drop trigger if exists audience_contacts_set_updated_at on public.audience_contacts;
create trigger audience_contacts_set_updated_at
  before update on public.audience_contacts
  for each row execute function public.lx_set_updated_at();

-- 2. Identities --------------------------------------------------------------

create table if not exists public.audience_identities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  provider text not null, -- 'project_user' | 'anonymous' | 'newsletter' | 'payment' | 'github' | 'coinpay_did' | ...
  external_id text not null,
  project_id uuid references public.projects(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(contact_id, provider, external_id)
);

create index if not exists audience_identities_lookup_idx
  on public.audience_identities(provider, external_id);

alter table public.audience_identities enable row level security;

drop policy if exists "audience_identities owner select" on public.audience_identities;
create policy "audience_identities owner select"
  on public.audience_identities for select
  using (
    exists (
      select 1 from public.audience_contacts c
      where c.id = contact_id
        and (
          c.owner_id = auth.uid()
          or (c.organization_id is not null and (select public.is_org_owner(c.organization_id, auth.uid())))
        )
    )
  );

drop trigger if exists audience_identities_set_updated_at on public.audience_identities;
create trigger audience_identities_set_updated_at
  before update on public.audience_identities
  for each row execute function public.lx_set_updated_at();

-- 3. Project membership links -------------------------------------------------

create table if not exists public.audience_project_links (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.audience_contacts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  external_user_id text,
  role text,
  plan text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}',
  unique(contact_id, project_id)
);

create index if not exists audience_project_links_project_idx
  on public.audience_project_links(project_id, last_seen_at desc);

alter table public.audience_project_links enable row level security;

drop policy if exists "audience_project_links owner select" on public.audience_project_links;
create policy "audience_project_links owner select"
  on public.audience_project_links for select
  using (
    exists (
      select 1 from public.audience_contacts c
      where c.id = contact_id
        and (
          c.owner_id = auth.uid()
          or (c.organization_id is not null and (select public.is_org_owner(c.organization_id, auth.uid())))
        )
    )
  );

-- 4. Events ------------------------------------------------------------------

create table if not exists public.audience_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.audience_contacts(id) on delete cascade,
  anonymous_id text not null default '',
  session_id text not null default '',
  project_id uuid not null references public.projects(id) on delete cascade,
  event text not null,
  source text not null check (source in ('browser', 'server', 'import')),
  url text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists audience_events_project_idx
  on public.audience_events(project_id, occurred_at desc);
create index if not exists audience_events_contact_idx
  on public.audience_events(contact_id, occurred_at desc);

alter table public.audience_events enable row level security;

drop policy if exists "audience_events owner select" on public.audience_events;
create policy "audience_events owner select"
  on public.audience_events for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (
          p.owner_id = auth.uid()
          or (p.organization_id is not null and (select public.is_org_owner(p.organization_id, auth.uid())))
        )
    )
  );

-- 5. Consent audit log ---------------------------------------------------------

create table if not exists public.audience_consent_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.audience_contacts(id) on delete cascade,
  email text not null,
  project_id uuid references public.projects(id) on delete set null,
  consent_type text not null default 'marketing_email'
    check (consent_type in ('marketing_email', 'transactional_email', 'product_updates', 'newsletter', 'cross_property_updates')),
  consent_value boolean not null,
  source text,
  ip_hash text,
  user_agent_hash text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists audience_consent_events_contact_idx
  on public.audience_consent_events(contact_id, occurred_at desc);

alter table public.audience_consent_events enable row level security;

drop policy if exists "audience_consent_events owner select" on public.audience_consent_events;
create policy "audience_consent_events owner select"
  on public.audience_consent_events for select
  using (
    contact_id is not null and exists (
      select 1 from public.audience_contacts c
      where c.id = contact_id
        and (
          c.owner_id = auth.uid()
          or (c.organization_id is not null and (select public.is_org_owner(c.organization_id, auth.uid())))
        )
    )
  );

-- 6. Per-project server ingest keys --------------------------------------------

create table if not exists public.project_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  created_by uuid references public.profiles(id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists project_api_keys_project_idx
  on public.project_api_keys(project_id, created_at desc);

alter table public.project_api_keys enable row level security;

drop policy if exists "project_api_keys owner select" on public.project_api_keys;
create policy "project_api_keys owner select"
  on public.project_api_keys for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id
        and (
          p.owner_id = auth.uid()
          or (p.organization_id is not null and (select public.is_org_owner(p.organization_id, auth.uid())))
        )
    )
  );

-- 7. Audience Hub install PRs reuse project_pr_runs ----------------------------

alter table public.project_pr_runs
  drop constraint if exists project_pr_runs_kind_check;
alter table public.project_pr_runs
  add constraint project_pr_runs_kind_check
  check (kind in ('install_tracker', 'apply_fix', 'audience_hub'));
