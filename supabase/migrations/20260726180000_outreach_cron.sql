-- Cron: advance every active outreach campaign.
--
-- Without this the campaign machinery exists but nothing drives it —
-- campaigns only move when someone clicks "Run now". This is the tick that
-- makes lead generation automated rather than manual.
--
-- Every 15 minutes, matching scan-watches. The tick is cheap and mostly
-- idle: it selects only active campaigns, and each one is bounded per tick
-- (15 discovered, 8 researched, 5 sends). Faster would not help — the slow
-- step is the scan worker, and the daily send caps are the real throttle.
--
-- What a tick does NOT do: send email from a campaign with auto_send off,
-- which is the default. Such a campaign discovers, scans, researches and
-- drafts, logging each message as a dry run. Turning sending on is a
-- separate, deliberate act in the UI, and it stays blocked until a CAN-SPAM
-- postal address is set.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-outreach') then
    perform cron.unschedule('crawlproof-outreach');
  end if;
end $$;

select cron.schedule(
  'crawlproof-outreach',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/outreach',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
