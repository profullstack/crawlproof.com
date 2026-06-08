-- DNS Analyzer scan type — enabled by default on every property.
--
-- 'dns' is a free engine (cost 0 in lib/credits): it resolves a domain's full
-- DNS footprint and has AI flag missing/weak/harmful records. We want it on by
-- default for all projects, so:
--   1) new projects get it in the column default, and
--   2) all existing projects are backfilled (the data migration).
--
-- projects.engines was added in 0009_project_engines.sql as
--   text[] not null default array['rule']::text[]

-- 1) New projects default to the free engines (rule + dns).
alter table public.projects
  alter column engines set default array['rule', 'dns']::text[];

-- 2) Backfill: add 'dns' to every existing project that doesn't already have
--    it, preserving each project's current engine selection.
update public.projects
  set engines = engines || array['dns']::text[]
  where not ('dns' = any(engines));
