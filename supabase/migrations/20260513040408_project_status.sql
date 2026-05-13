-- projects.status decouples "is this scheduled cadence running right now"
-- from the cadence itself. Schedule still encodes weekly vs monthly; status
-- is the pause/active/archived switch the user toggles.

alter table public.projects
  add column if not exists status text not null default 'active'
  check (status in ('active', 'paused', 'archived'));

alter table public.projects
  add column if not exists archived_at timestamptz;

-- Cron sweep filters on status='active' AND schedule != 'off', so a partial
-- index keeps the scheduled-audits query cheap.
create index if not exists projects_due_idx
  on public.projects (next_run_at)
  where status = 'active' and schedule <> 'off';

-- Backfill: every existing row is implicitly active. The default handles
-- new inserts; this is just belt-and-braces in case any row got created
-- before the default kicked in.
update public.projects set status = 'active' where status is null;
