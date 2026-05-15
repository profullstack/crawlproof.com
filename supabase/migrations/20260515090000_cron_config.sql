-- Cron config moved from app.* GUCs to a Postgres table.
--
-- Background: 0003_cron.sql + 20260514110000_lx_autoblog_cron.sql both
-- relied on current_setting('app.site_url', true) / 'app.cron_secret'
-- to template the net.http_post() URL + header. Managed Supabase only
-- allows custom app.* GUCs via supabase_admin (superuser) — the
-- `postgres` role we run migrations as cannot ALTER DATABASE/ROLE SET
-- them. The migrations succeeded but the GUCs were never populated, so
-- net.http_post() was called with url=NULL and pg_cron silently failed
-- every hour with "null value in column url violates not-null constraint".
--
-- Fix: read the values from a regular table. Service-role only.

create table if not exists public.cron_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.cron_config enable row level security;
-- No policies = deny everything to anon/authenticated. Service role
-- bypasses RLS so the cron body (running as 'postgres') can read it.

comment on table public.cron_config is
  'Key/value config for pg_cron jobs. Seed via INSERT; not in migrations '
  'so the cron_secret never enters the repo. Required keys: site_url, '
  'cron_secret.';

-- Unschedule the broken jobs if they exist, then re-add them with the
-- new table-based body. cron.unschedule is idempotent on the jobid form
-- but errors on a missing name, so guard with EXISTS.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-scheduled-audits') then
    perform cron.unschedule('crawlproof-scheduled-audits');
  end if;
  if exists (select 1 from cron.job where jobname = 'crawlproof-lx-autoblog') then
    perform cron.unschedule('crawlproof-lx-autoblog');
  end if;
end $$;

select cron.schedule(
  'crawlproof-scheduled-audits',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/scheduled-audits',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'crawlproof-lx-autoblog',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/lx-autoblog',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
