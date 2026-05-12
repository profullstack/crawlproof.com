-- Scheduled re-audits via pg_cron.
-- pg_cron and pg_net are Supabase-managed extensions.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Hourly job that hits our Next.js cron endpoint, which enqueues any projects
-- whose next_run_at has passed.
select cron.schedule(
  'crawlproof-scheduled-audits',
  '0 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.site_url', true) || '/api/cron/scheduled-audits',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To configure, run once on the database:
--   alter database postgres set app.site_url = 'https://crawlproof.com';
--   alter database postgres set app.cron_secret = 'YOUR_CRON_SECRET';
