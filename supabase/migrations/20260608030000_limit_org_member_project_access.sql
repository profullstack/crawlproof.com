-- Org membership is for workspace-level features, not blanket project access.
--
-- Project access should come from:
--   - projects.owner_id = auth.uid()
--   - explicit public.project_members membership
--   - org-owner access to administer projects in the org
--
-- The earlier org migration gave every organization member read access to every
-- project in that org. That made a plain org team member see unrelated
-- projects. Keep the owner/admin policy, but remove the broad member read.

drop policy if exists "projects org member read" on public.projects;
drop policy if exists "projects org owner read" on public.projects;

create policy "projects org owner read"
  on public.projects for select
  using (
    organization_id is not null
    and (select public.is_org_owner(organization_id, (select auth.uid())))
  );
