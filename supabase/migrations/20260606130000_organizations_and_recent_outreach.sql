-- Organization ownership layer + paid-owner outreach from Recent scans.
-- Existing project owner/member access remains in place; orgs give us a
-- migration path for grouping projects and moving them without breaking
-- current project URLs or policies.

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists organizations_owner_idx
  on public.organizations(owner_id, created_at desc);

alter table public.organizations enable row level security;

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists organization_members_user_idx
  on public.organization_members(user_id, organization_id);
create index if not exists organization_members_org_role_idx
  on public.organization_members(organization_id, role);

alter table public.organization_members enable row level security;

create or replace function public.is_org_member(p_org_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.organization_members
    where organization_id = p_org_id and user_id = p_user_id
  )
$$;

create or replace function public.is_org_owner(p_org_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.organization_members
    where organization_id = p_org_id and user_id = p_user_id and role = 'owner'
  )
$$;

drop policy if exists "organizations member select" on public.organizations;
drop policy if exists "organizations owner insert" on public.organizations;
drop policy if exists "organizations owner update" on public.organizations;
drop policy if exists "organizations owner delete" on public.organizations;

create policy "organizations member select"
  on public.organizations for select
  using ((select public.is_org_member(id, auth.uid())));

create policy "organizations owner insert"
  on public.organizations for insert
  with check (owner_id = (select auth.uid()));

create policy "organizations owner update"
  on public.organizations for update
  using ((select public.is_org_owner(id, auth.uid())))
  with check ((select public.is_org_owner(id, auth.uid())));

create policy "organizations owner delete"
  on public.organizations for delete
  using ((select public.is_org_owner(id, auth.uid())));

drop policy if exists "organization_members member select" on public.organization_members;
drop policy if exists "organization_members owner insert" on public.organization_members;
drop policy if exists "organization_members owner update" on public.organization_members;
drop policy if exists "organization_members owner delete" on public.organization_members;

create policy "organization_members member select"
  on public.organization_members for select
  using ((select public.is_org_member(organization_id, auth.uid())));

create policy "organization_members owner insert"
  on public.organization_members for insert
  with check ((select public.is_org_owner(organization_id, auth.uid())));

create policy "organization_members owner update"
  on public.organization_members for update
  using ((select public.is_org_owner(organization_id, auth.uid())))
  with check ((select public.is_org_owner(organization_id, auth.uid())));

create policy "organization_members owner delete"
  on public.organization_members for delete
  using ((select public.is_org_owner(organization_id, auth.uid())));

alter table public.profiles
  add column if not exists default_org_id uuid references public.organizations(id) on delete set null;

alter table public.projects
  add column if not exists organization_id uuid references public.organizations(id) on delete set null;

create index if not exists projects_organization_idx
  on public.projects(organization_id, created_at desc);

-- Backfill one default org per existing profile.
insert into public.organizations (owner_id, name)
select
  p.id,
  coalesce(nullif(trim(p.display_name), ''), split_part(coalesce(p.email, 'Workspace'), '@', 1), 'Workspace') || ' workspace'
from public.profiles p
where not exists (
  select 1 from public.organizations o where o.owner_id = p.id
);

insert into public.organization_members (organization_id, user_id, role)
select o.id, o.owner_id, 'owner'
from public.organizations o
on conflict (organization_id, user_id) do update set role = 'owner';

update public.profiles p
set default_org_id = o.id
from (
  select distinct on (owner_id) id, owner_id
  from public.organizations
  order by owner_id, created_at asc
) o
where p.id = o.owner_id
  and p.default_org_id is null;

update public.projects pr
set organization_id = p.default_org_id
from public.profiles p
where pr.owner_id = p.id
  and pr.organization_id is null;

drop policy if exists "projects org member read" on public.projects;
drop policy if exists "projects org owner update" on public.projects;

create policy "projects org member read"
  on public.projects for select
  using (
    organization_id is not null
    and (select public.is_org_member(organization_id, auth.uid()))
  );

create policy "projects org owner update"
  on public.projects for update
  using (
    organization_id is not null
    and (select public.is_org_owner(organization_id, auth.uid()))
  )
  with check (
    organization_id is not null
    and (select public.is_org_owner(organization_id, auth.uid()))
  );

create or replace function public.create_default_org_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if new.default_org_id is not null then
    return new;
  end if;

  insert into public.organizations (owner_id, name)
  values (
    new.id,
    coalesce(nullif(trim(new.display_name), ''), split_part(coalesce(new.email, 'Workspace'), '@', 1), 'Workspace') || ' workspace'
  )
  returning id into v_org_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org_id, new.id, 'owner')
  on conflict (organization_id, user_id) do update set role = 'owner';

  update public.profiles
  set default_org_id = v_org_id
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists profile_create_default_org on public.profiles;
create trigger profile_create_default_org
  after insert on public.profiles
  for each row execute function public.create_default_org_for_profile();

create table if not exists public.recent_outreach_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  audit_id uuid not null references public.audits(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  provider text not null,
  recipient_hash text not null,
  subject text,
  body text not null,
  status text not null default 'sent' check (status in ('sent', 'failed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists recent_outreach_org_created_idx
  on public.recent_outreach_messages(organization_id, created_at desc);
create index if not exists recent_outreach_audit_idx
  on public.recent_outreach_messages(audit_id, created_at desc);

alter table public.recent_outreach_messages enable row level security;

drop policy if exists "recent_outreach owner select" on public.recent_outreach_messages;
drop policy if exists "recent_outreach owner insert" on public.recent_outreach_messages;

create policy "recent_outreach owner select"
  on public.recent_outreach_messages for select
  using ((select public.is_org_owner(organization_id, auth.uid())));

create policy "recent_outreach owner insert"
  on public.recent_outreach_messages for insert
  with check ((select public.is_org_owner(organization_id, auth.uid())));

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.lx_set_updated_at();
