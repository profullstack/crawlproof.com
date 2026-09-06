-- Nightly performance reports.
--
-- The cadence column already gates who gets a digest and how often; this
-- adds 'daily' to it and makes it the default, so a new account gets the
-- nightly traffic summary without having to find the setting.
--
-- Existing rows keep whatever their owner chose. A default only applies to
-- inserts, and silently moving somebody from weekly to nightly would be
-- changing a preference they set, not honouring one.
--
-- Apply one file at a time via the Supabase MCP's apply_migration — prod's
-- migration history has diverged from this directory, so `supabase db push`
-- would try to replay files prod already has.

alter table public.profiles
  drop constraint if exists profiles_perf_report_cadence_check;

alter table public.profiles
  add constraint profiles_perf_report_cadence_check
  check (perf_report_cadence in ('off', 'daily', 'weekly', 'monthly'));

alter table public.profiles
  alter column perf_report_cadence set default 'daily';

-- The hourly cron reads `where perf_report_cadence <> 'off'`; the existing
-- index still covers it, and daily simply makes more rows eligible per tick.
