-- Schedule the daily AI spend warning.
--
-- Hourly rather than daily, so a day that runs away is noticed while it is
-- still running. The alert de-duplicates on (day, threshold), so the extra
-- runs cost a query and send nothing.
--
-- The route only ever warns — it does not throttle, pause, or block. A
-- budget alarm that turns the product off is worse than the bill it was
-- meant to prevent.

select cron.schedule(
  'crawlproof-ai-spend',
  '7 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/ai-spend',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
