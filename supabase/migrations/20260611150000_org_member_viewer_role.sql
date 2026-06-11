-- Org-level read-only members ("viewers").
--
-- Parallels the project-level viewer role (20260611120000_project_member_viewer_role.sql):
--   owner/member = full org-wide access (read + write)
--   viewer       = org-wide READ-ONLY: sees every project in the org and its
--                  data, but cannot mutate any project or org settings
--   project_member = org-visible marker only (access comes from project_members)
--
-- Reads are granted by widening the org-wide READ helpers (is_org_wide_member,
-- is_project_member's org branch) to include 'viewer'. Writes are unchanged:
-- is_project_editor and is_org_owner keep their ('owner','member') / owner
-- checks, so viewers stay write-blocked everywhere.

alter table public.organization_members
  drop constraint if exists organization_members_role_check;
alter table public.organization_members
  add constraint organization_members_role_check
  check (role in ('owner', 'member', 'viewer', 'project_member'));

-- Carry the chosen role through the invitation so it is applied on accept.
alter table public.organization_invitations
  add column if not exists role text not null default 'member';
alter table public.organization_invitations
  drop constraint if exists organization_invitations_role_check;
alter table public.organization_invitations
  add constraint organization_invitations_role_check
  check (role in ('member', 'viewer'));

-- Org-wide READ access now includes viewers. Every usage of this helper is a
-- SELECT policy (projects / integrations / event_outbox / webhook_events), so
-- this grants reads only.
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
      and role in ('owner', 'member', 'viewer')
  )
$$;

-- Project READ via org membership now includes viewers. Project WRITES use
-- is_project_editor (unchanged), which still excludes viewers.
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
      and om.role in ('owner', 'member', 'viewer')
  )
$$;
