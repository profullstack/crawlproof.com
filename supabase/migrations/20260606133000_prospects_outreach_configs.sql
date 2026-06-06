-- Prospects workspace + per-org outreach sender configs.
-- Anonymous/free scans can be tagged to the Prospects org so the team can
-- follow up by email/SMS and later social posting without inventing a fake
-- project per lead.

alter table public.audits
  add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create index if not exists audits_organization_created_idx
  on public.audits(organization_id, created_at desc);

create table if not exists public.organization_outreach_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  label text not null,
  channel text not null check (channel in ('email', 'sms', 'social')),
  provider text not null check (provider in ('smtp', 'resend', 'twilio', 'telnyx', 'manual')),
  enabled boolean not null default true,
  is_default boolean not null default false,
  from_email text,
  from_phone text,
  reply_to text,
  smtp_host text,
  smtp_port int,
  smtp_secure boolean,
  smtp_user text,
  smtp_pass text,
  api_key text,
  account_sid text,
  auth_token text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organization_outreach_configs_org_idx
  on public.organization_outreach_configs(organization_id, channel, enabled);

create unique index if not exists organization_outreach_configs_one_default_idx
  on public.organization_outreach_configs(organization_id, channel)
  where is_default and enabled;

alter table public.organization_outreach_configs enable row level security;

drop policy if exists "organization_outreach_configs owner all"
  on public.organization_outreach_configs;

create policy "organization_outreach_configs owner all"
  on public.organization_outreach_configs for all
  using ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));

drop trigger if exists organization_outreach_configs_set_updated_at
  on public.organization_outreach_configs;
create trigger organization_outreach_configs_set_updated_at
  before update on public.organization_outreach_configs
  for each row execute function public.lx_set_updated_at();

-- Bootstrap a Prospects org for the founder/admin account when present.
insert into public.organizations (owner_id, name)
select p.id, 'Prospects'
from public.profiles p
where lower(p.email) = lower('anthony@profullstack.com')
  and not exists (
    select 1
    from public.organizations o
    where o.owner_id = p.id and lower(o.name) = lower('Prospects')
  );

insert into public.organization_members (organization_id, user_id, role)
select o.id, o.owner_id, 'owner'
from public.organizations o
where lower(o.name) = lower('Prospects')
on conflict (organization_id, user_id) do update set role = 'owner';

update public.audits a
set organization_id = o.id
from public.organizations o
join public.profiles p on p.id = o.owner_id
where a.owner_id is null
  and a.organization_id is null
  and lower(o.name) = lower('Prospects')
  and lower(p.email) = lower('anthony@profullstack.com');
