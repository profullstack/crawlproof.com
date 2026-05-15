-- Hourly cron that drives weekly + monthly performance digests.
--
-- Each tick, /api/cron/perf-reports finds every profile whose local
-- time matches their cadence's send slot (Mon 09:00 weekly, 1st 09:00
-- monthly) and emails the digest. Most ticks send 0 emails — the
-- per-user "is it 09:00 in their TZ?" check is what spreads the load.
--
-- Uses public.cron_config(key, value) for site_url + cron_secret
-- (the GUC indirection from 0003_cron.sql doesn't work on managed
-- Supabase — see 20260515090000_cron_config.sql for context).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-perf-reports') then
    perform cron.unschedule('crawlproof-perf-reports');
  end if;
end $$;

select cron.schedule(
  'crawlproof-perf-reports',
  '0 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/perf-reports',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
