-- Purge stale lx_site rows that are blocking new autoblog creation.
--
-- Root cause: lx_site rows survive project deletion when the cascade
-- wasn't wired up at the time of deletion, OR when deleteAutoblog was
-- called instead of deleteProject (which leaves the project row but
-- removes lx_site — correct), but a subsequent full project delete
-- left the domain slot occupied.
--
-- Specifically clean up vu1nz.com which was reported stuck for
-- devpreshy@gmail.com. Also cleans any other orphaned rows (project
-- no longer exists) so this never recurs.

-- 1. Delete lx_site rows whose project was deleted (project_id points
--    to a non-existent project row). The ON DELETE CASCADE on the FK
--    should handle this automatically, but rows created before cascade
--    was applied slip through.
delete from public.lx_site
where project_id is not null
  and not exists (
    select 1 from public.projects p where p.id = lx_site.project_id
  );

-- 2. Delete lx_site rows with no project_id at all (pre-migration
--    orphans from before the 1:1 project unification).
delete from public.lx_site
where project_id is null;

-- 3. Ensure the lx_site.project_id FK is ON DELETE CASCADE so future
--    project deletes always clean up automatically.
alter table public.lx_site
  drop constraint if exists lx_site_project_id_fkey;

alter table public.lx_site
  add constraint lx_site_project_id_fkey
  foreign key (project_id)
  references public.projects(id)
  on delete cascade;
