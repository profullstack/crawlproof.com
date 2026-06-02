-- Allow project team members to read and update lx_site rows for their project.
--
-- The existing "lx_site owner all" policy gates on user_id = auth.uid(),
-- which is the site creator (always the project owner). Team members have
-- a different auth.uid() and were being blocked, causing "Project not found"
-- errors when saving autoblog config.
--
-- We reuse is_project_member() (SECURITY DEFINER, avoids recursive RLS)
-- which was introduced in 20260602110000_fix_member_rls_circular.sql.

create policy "lx_site member select"
  on public.lx_site for select
  using (
    project_id is not null
    and public.is_project_member(project_id, auth.uid())
  );

create policy "lx_site member update"
  on public.lx_site for update
  using (
    project_id is not null
    and public.is_project_member(project_id, auth.uid())
  )
  with check (
    project_id is not null
    and public.is_project_member(project_id, auth.uid())
  );

create policy "lx_site member insert"
  on public.lx_site for insert
  with check (
    project_id is not null
    and public.is_project_member(project_id, auth.uid())
  );
