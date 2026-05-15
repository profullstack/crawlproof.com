-- Weekly / monthly performance-report digest.
--
-- One combined email per user (audit scores + autoblog activity).
-- Cadence is per-user via profiles.perf_report_cadence; users default
-- to 'weekly' so the feature is on out of the box. Send time is Mon
-- 09:00 (weekly) or 1st-of-month 09:00 (monthly), in the user's local
-- timezone. profiles.perf_report_last_sent_at is the dedupe key —
-- the hourly cron only sends when it hasn't already this window.

alter table public.profiles
  add column if not exists perf_report_cadence text not null default 'weekly'
  check (perf_report_cadence in ('off', 'weekly', 'monthly'));

alter table public.profiles
  add column if not exists timezone text not null default 'UTC';

alter table public.profiles
  add column if not exists perf_report_last_sent_at timestamptz;

-- Hourly: lookup matches `where perf_report_cadence <> 'off'` against
-- ~10k rows max. Partial index keeps it cheap as the table grows.
create index if not exists profiles_perf_report_cadence_idx
  on public.profiles(perf_report_cadence)
  where perf_report_cadence <> 'off';
