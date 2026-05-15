-- Hourly cron that drives Autoblog article publishing.
-- Each tick, /api/cron/lx-autoblog finds every active lx_site whose
-- next_publish_at has passed, enqueues an article generation, and
-- advances next_publish_at to the next slot in publish_days.
--
-- Reuses the same app.site_url + app.cron_secret GUCs configured in
-- 0003_cron.sql — no new GUCs needed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'crawlproof-lx-autoblog',
  '0 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.site_url', true) || '/api/cron/lx-autoblog',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', current_setting('app.cron_secret', true)
    ),
    body := '{}'::jsonb
  );
  $$
);
