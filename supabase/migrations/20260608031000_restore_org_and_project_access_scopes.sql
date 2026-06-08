-- Support both collaboration scopes:
--   - org_membership: access to projects in that organization
--   - project_membership: access to one explicit project, regardless of org
--
-- 20260608030000 temporarily removed org-member project visibility while
-- addressing an over-broad dashboard exposure. The real fix is app-side
-- filtering that includes explicit project memberships alongside selected org
-- scope, so restore org-level project reads here.

drop policy if exists "projects org owner read" on public.projects;
drop policy if exists "projects org member read" on public.projects;

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
  )
$$;

create policy "projects org member read"
  on public.projects for select
  using (
    organization_id is not null
    and (select public.is_org_member(organization_id, (select auth.uid())))
  );
