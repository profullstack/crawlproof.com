-- ============================================================
-- Scan leads exported to OutreachGraph (and through its public
-- directory, the scanned companies to nichedb). One row per address
-- per destination: the cron sends only what is not here yet.
-- ============================================================
create table if not exists public.lead_exports (
  email text not null,
  destination text not null,
  company_domain text,
  import_id text,
  exported_at timestamptz not null default now(),
  primary key (email, destination)
);

-- Service role only: no policies.
alter table public.lead_exports enable row level security;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-lead-export') then
    perform cron.unschedule('crawlproof-lead-export');
  end if;
end $$;

select cron.schedule(
  'crawlproof-lead-export',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/lead-export',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
