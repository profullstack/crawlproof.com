-- Project-level collaborators should see the parent organization in the
-- workspace picker without receiving blanket access to every project in it.
--
-- Roles:
--   owner/member      = org-wide access
--   project_member   = org-visible marker; project access still comes from
--                      explicit public.project_members rows

alter table public.organization_members
  drop constraint if exists organization_members_role_check;

alter table public.organization_members
  add constraint organization_members_role_check
  check (role in ('owner', 'member', 'project_member'));

create or replace function public.is_org_member(p_org_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1
    from public.organization_members
    where organization_id = p_org_id
      and user_id = p_user_id
  )
$$;

create or replace function public.is_org_wide_member(p_org_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1
    from public.organization_members
    where organization_id = p_org_id
      and user_id = p_user_id
      and role in ('owner', 'member')
  )
$$;

create or replace function public.is_project_member(p_project_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.user_id = p_user_id
  )
  or exists(
    select 1
    from public.projects p
    join public.organization_members om
      on om.organization_id = p.organization_id
    where p.id = p_project_id
      and om.user_id = p_user_id
      and om.role in ('owner', 'member')
  )
$$;

drop policy if exists "projects org member read" on public.projects;
drop policy if exists "projects org owner read" on public.projects;

create policy "projects org member read"
  on public.projects for select
  using (
    organization_id is not null
    and (select public.is_org_wide_member(organization_id, (select auth.uid())))
  );

drop policy if exists "integrations org member select" on public.integrations;
create policy "integrations org member select"
  on public.integrations for select
  using (
    org_id is not null
    and (select public.is_org_wide_member(org_id, auth.uid()))
  );

drop policy if exists "event_outbox org member select" on public.event_outbox;
create policy "event_outbox org member select"
  on public.event_outbox for select
  using (
    org_id is not null
    and (select public.is_org_wide_member(org_id, auth.uid()))
  );

drop policy if exists "webhook_events org member select" on public.webhook_events;
create policy "webhook_events org member select"
  on public.webhook_events for select
  using (
    org_id is not null
    and (select public.is_org_wide_member(org_id, auth.uid()))
  );

insert into public.organization_members (organization_id, user_id, role)
select distinct
  p.organization_id,
  pm.user_id,
  'project_member'
from public.project_members pm
join public.projects p
  on p.id = pm.project_id
where p.organization_id is not null
  and not exists (
    select 1
    from public.organization_members om
    where om.organization_id = p.organization_id
      and om.user_id = pm.user_id
  );
