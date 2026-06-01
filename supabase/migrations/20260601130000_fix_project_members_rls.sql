-- Fix circular RLS: project_members policy referenced projects (with RLS),
-- which referenced project_members (with RLS), causing infinite recursion
-- and breaking all project queries.
--
-- Solution: use a SECURITY DEFINER function to check project ownership,
-- which bypasses RLS when reading projects and breaks the loop.

create or replace function public.project_owner_id(p_project_id uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select owner_id from public.projects where id = p_project_id
$$;

drop policy "project_members owner all" on public.project_members;

create policy "project_members owner all"
  on public.project_members for all
  using  (public.project_owner_id(project_id) = auth.uid())
  with check (public.project_owner_id(project_id) = auth.uid());
