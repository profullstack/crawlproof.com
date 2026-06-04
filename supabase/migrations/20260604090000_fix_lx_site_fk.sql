-- Fix lx_site.project_id FK after cleanup migration may have created a
-- duplicate constraint, making the PostgREST projects→lx_site join ambiguous
-- (returns lx_site: null for all rows).
--
-- The prior cleanup migration did DROP CONSTRAINT IF EXISTS lx_site_project_id_fkey
-- then ADD CONSTRAINT lx_site_project_id_fkey. If the original constraint had a
-- different auto-generated name (Postgres appends type info in some versions),
-- the DROP was a no-op and ADD created a second FK. Two FKs on the same column
-- pair break PostgREST's ability to resolve the implicit join.
--
-- This migration drops ALL FKs on lx_site.project_id and re-adds exactly one,
-- named canonically so PostgREST can resolve the join unambiguously.

-- Drop whichever FK constraints exist on lx_site.project_id (covers any name).
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.lx_site'::regclass
      and contype = 'f'
      and conkey @> array[
        (select attnum from pg_attribute
         where attrelid = 'public.lx_site'::regclass
           and attname = 'project_id')
      ]::smallint[]
  loop
    execute format('alter table public.lx_site drop constraint %I', r.conname);
  end loop;
end;
$$;

-- Re-add exactly one FK, CASCADE so project deletes clean up automatically.
alter table public.lx_site
  add constraint lx_site_project_id_fkey
  foreign key (project_id)
  references public.projects(id)
  on delete cascade;
