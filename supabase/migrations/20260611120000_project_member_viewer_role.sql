-- Read-only team members ("viewers").
--
-- A project_members row can now carry a role:
--   'member' (default) — full collaborator: read + write project data
--   'viewer'           — read-only: sees everything a member sees, but
--                        cannot mutate any project data
--
-- Read access is unchanged (every SELECT policy keeps using
-- is_project_member, which includes viewers). We gate every member WRITE
-- policy behind a new is_project_editor() check that excludes viewers.

alter table public.project_members
  add column if not exists role text not null default 'member';

alter table public.project_members
  drop constraint if exists project_members_role_check;
alter table public.project_members
  add constraint project_members_role_check
  check (role in ('member', 'viewer'));

-- Carry the chosen role through the invitation so it is applied on accept.
alter table public.project_invitations
  add column if not exists role text not null default 'member';

alter table public.project_invitations
  drop constraint if exists project_invitations_role_check;
alter table public.project_invitations
  add constraint project_invitations_role_check
  check (role in ('member', 'viewer'));

-- is_project_editor: a user allowed to WRITE project data.
-- Mirrors is_project_member (latest definition) but excludes viewers on the
-- explicit-membership branch. Org owner/member retain write access; the org
-- 'project_member' visibility marker grants nothing on its own.
create or replace function public.is_project_editor(p_project_id uuid, p_user_id uuid)
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
      and pm.role = 'member'
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

-- ── projects (member update) ─────────────────────────────────────────────
drop policy if exists "projects member update" on public.projects;
create policy "projects member update"
  on public.projects for update
  using  (public.is_project_editor(id, auth.uid()))
  with check (public.is_project_editor(id, auth.uid()));

-- ── project_repos (member insert) ────────────────────────────────────────
drop policy if exists "project_repos member insert" on public.project_repos;
create policy "project_repos member insert"
  on public.project_repos for insert
  with check (public.is_project_editor(project_id, auth.uid()));

-- ── tracker_integrations (member insert/update/delete) ───────────────────
drop policy if exists "tracker_integrations member insert" on public.tracker_integrations;
create policy "tracker_integrations member insert"
  on public.tracker_integrations for insert
  with check (public.is_project_editor(project_id, auth.uid()));

drop policy if exists "tracker_integrations member update" on public.tracker_integrations;
create policy "tracker_integrations member update"
  on public.tracker_integrations for update
  using  (public.is_project_editor(project_id, auth.uid()))
  with check (public.is_project_editor(project_id, auth.uid()));

drop policy if exists "tracker_integrations member delete" on public.tracker_integrations;
create policy "tracker_integrations member delete"
  on public.tracker_integrations for delete
  using (public.is_project_editor(project_id, auth.uid()));

-- ── lx_site (member update/insert) ───────────────────────────────────────
drop policy if exists "lx_site member update" on public.lx_site;
create policy "lx_site member update"
  on public.lx_site for update
  using (
    project_id is not null
    and public.is_project_editor(project_id, auth.uid())
  )
  with check (
    project_id is not null
    and public.is_project_editor(project_id, auth.uid())
  );

drop policy if exists "lx_site member insert" on public.lx_site;
create policy "lx_site member insert"
  on public.lx_site for insert
  with check (
    project_id is not null
    and public.is_project_editor(project_id, auth.uid())
  );
