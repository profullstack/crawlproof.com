-- Each project stores a list of engines it runs on a scan. Manual scans can
-- override the list; the scheduled cron path reads project.engines at fire
-- time so users can deselect engines mid-cycle without overpaying on the
-- next run. Default = rule-only so old projects don't suddenly cost credits.

alter table public.projects
  add column if not exists engines text[] not null default array['rule']::text[];

-- Sanity: each engine string must be one of the known values.
-- (We don't enforce a CHECK on array elements directly in Postgres — that
-- needs a trigger — but the application layer validates on insert/update.)
