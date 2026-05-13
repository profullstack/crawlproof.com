-- Allow projects.schedule = 'daily' in addition to off/weekly/monthly.
-- The check constraint was defined inline in 0001_init.sql; Postgres
-- assigns it the default name projects_schedule_check.

alter table public.projects
  drop constraint if exists projects_schedule_check;

alter table public.projects
  add constraint projects_schedule_check
  check (schedule in ('off', 'daily', 'weekly', 'monthly'));
