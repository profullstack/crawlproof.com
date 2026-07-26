-- "Watch this URL" — recurring re-scans of a URL for an email address that
-- asked for them (M2 of docs/lead-engine-prd.md).
--
-- Double opt-in by construction: a row is inert until verified_at is set by
-- the confirmation link. Nothing recurring is ever sent to an address that
-- did not click.

create table if not exists public.scan_watches (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  target_url text not null,
  engine text not null default 'slop' check (engine in ('rule', 'slop')),
  cadence text not null default 'weekly' check (cadence in ('weekly', 'monthly')),

  -- Separate secrets: confirming a watch and killing it are different
  -- actions, and the kill link ships in every email we send.
  confirm_token text not null unique,
  unsubscribe_token text not null unique,

  verified_at timestamptz,
  unsubscribed_at timestamptz,

  -- The audit this watch was created from, so the first re-scan can be
  -- compared against a number the subscriber has already seen.
  origin_audit_id uuid references public.audits(id) on delete set null,
  -- An in-flight re-scan. Scans complete asynchronously in the worker, so the
  -- cron enqueues here on one tick and delivers the email on a later one.
  pending_audit_id uuid references public.audits(id) on delete set null,

  last_score int,
  last_scanned_at timestamptz,
  last_notified_at timestamptz,
  next_run_at timestamptz not null default now(),

  created_ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One watch per address per target per engine. Re-submitting the same pair
-- should re-send the confirmation, not stack duplicate rows.
create unique index if not exists scan_watches_email_target_engine_idx
  on public.scan_watches (lower(trim(email)), target_url, engine);

-- The cron's due-work query.
create index if not exists scan_watches_due_idx
  on public.scan_watches (next_run_at)
  where verified_at is not null and unsubscribed_at is null;

-- The cron's delivery query.
create index if not exists scan_watches_pending_idx
  on public.scan_watches (pending_audit_id)
  where pending_audit_id is not null;

create index if not exists scan_watches_email_idx
  on public.scan_watches (lower(trim(email)));

-- Watch re-scans need their own provenance. Without widening this, the cron's
-- inserts fail the check constraint (verified against prod: the constraint is
-- named audits_triggered_by_check and allows only manual/scheduled), and
-- reusing 'scheduled' would blend watch runs into project-schedule analytics.
alter table public.audits drop constraint if exists audits_triggered_by_check;
alter table public.audits add constraint audits_triggered_by_check
  check (triggered_by in ('manual', 'scheduled', 'watch'));

alter table public.scan_watches enable row level security;

-- No policies, deliberately. Watches are created and read by anonymous
-- visitors through server actions using the service-role client, which
-- bypasses RLS; exposing them to anon/authenticated would let anyone
-- enumerate which addresses are watching which sites.

comment on table public.scan_watches is
  'Opt-in recurring re-scans of a URL for an email address. Inert until '
  'verified_at is set by the confirmation link. Service-role access only.';

drop trigger if exists scan_watches_set_updated_at on public.scan_watches;
create trigger scan_watches_set_updated_at
  before update on public.scan_watches
  for each row execute function public.lx_set_updated_at();

-- ============================================================
-- Cron: tick every 15 minutes. The tick is cheap — it only picks up watches
-- whose own next_run_at has passed (weekly/monthly), so a frequent tick just
-- keeps delivery latency low rather than over-scanning. The same tick also
-- delivers results for scans enqueued on an earlier one.
-- ============================================================
do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-scan-watches') then
    perform cron.unschedule('crawlproof-scan-watches');
  end if;
end $$;

select cron.schedule(
  'crawlproof-scan-watches',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/scan-watches',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
