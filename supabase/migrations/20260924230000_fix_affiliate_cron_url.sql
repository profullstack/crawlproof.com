-- Fix the crawlproof-affiliate cron job, which has never once run.
--
-- 20260913120000_openaffiliate.sql scheduled it with
--   url := current_setting('app.site_url', true) || '/api/cron/affiliate'
-- which is the pattern 20260515090000_cron_config.sql had already removed
-- four months earlier, for exactly the reason its header describes: the
-- app.* GUCs can only be set by supabase_admin, migrations run as `postgres`,
-- so they are never populated. current_setting(..., true) then returns NULL,
-- `NULL || '/api/cron/affiliate'` is NULL, and pg_net rejects the row with
--   null value in column "url" of relation "http_request_queue"
--   violates not-null constraint
--
-- It fails silently in the sense that matters: `cron.job_run_details` is the
-- only place it shows up, nothing alerts on it, and every other job is green.
-- Found on 2026-09-24 while auditing the ten jobs after the move to dev2 —
-- the Supabase cloud project had been failing this same job hourly since
-- 2026-09-13, so the migration to self-hosting reproduced it rather than
-- causing it.
--
-- Fixed the same way the 2026-05 migration fixed the others: read the values
-- from public.cron_config. Deliberately NOT by setting the GUCs — a
-- database-level setting is invisible to pg_dump, so it would be lost by the
-- next migration and this would come back a third time.
--
-- cron.schedule() upserts by job name, so this is idempotent and safe to
-- re-run.

select cron.schedule(
  'crawlproof-affiliate',
  '23 * * * *',
  $cron$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/affiliate',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- Guard: fail the migration loudly if cron_config cannot actually build the
-- URL, rather than scheduling another job that dies hourly in silence.
do $$
declare u text;
begin
  select (select value from public.cron_config where key = 'site_url') || '/api/cron/affiliate' into u;
  if u is null then
    raise exception 'cron_config.site_url is missing — crawlproof-affiliate would post to a NULL url again';
  end if;
  if (select value from public.cron_config where key = 'cron_secret') is null then
    raise exception 'cron_config.cron_secret is missing — the affiliate route would reject every call with 401';
  end if;
  raise notice 'crawlproof-affiliate will post to %', u;
end $$;
