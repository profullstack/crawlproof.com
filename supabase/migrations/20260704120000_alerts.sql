-- CrawlProof Alerts — free, near-realtime email alerts powered by ValueSERP,
-- with the existing crawler used to confirm backlinks.
--
-- Design notes (see docs/crawlproof-alerts-prd.md §"Implementation status"):
--  * The free cap is enforced on TWO axes: a hard limit on active alerts
--    (the spec's "50 queries") AND a monthly per-account SERP call budget,
--    which is the real cost backstop. A single power user maxing 50 daily
--    alerts would otherwise cost ~$1.50/mo in ValueSERP alone — 10× the
--    stated $0.15/free-user ceiling — so the call budget, not the alert
--    count, is what actually bounds spend.
--  * alert.seeded implements the cold-start rule: an alert's FIRST poll only
--    seeds the seen-URL set (no email); value on creation comes from the
--    instant "test run" preview, not a blast of pre-existing SERP results.
--  * alert_findings.emailed_at NULL = pending. The worker batches every
--    pending finding across ALL of a user's alerts into ONE digest, rather
--    than one email per alert (50 alerts × daily would otherwise be up to
--    50 emails/day/user — a deliverability and fatigue hazard).

-- ============================================================
-- profiles — per-account alert budget columns.
-- ============================================================
alter table public.profiles
  add column if not exists alert_serp_calls_used int not null default 0;

alter table public.profiles
  add column if not exists alert_serp_calls_reset_at timestamptz not null default (now() + interval '30 days');

-- ============================================================
-- alerts — one saved, active monitor. A "query" in the PRD's free-cap sense.
-- ============================================================
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  -- Delivery address. Equals the owner's email in v1 (single email/account),
  -- but stored per-alert so a future multi-address model is non-breaking.
  email text not null,
  -- Category key from lib/alerts/categories.ts (e.g. 'brand', 'backlink').
  category text not null,
  -- User-facing label, e.g. "Brand mentions of Acme".
  label text not null,
  -- The raw term the user typed (brand / name / domain / keyword).
  input_term text not null default '',
  -- The compiled ValueSERP `q` (operators hidden from the user).
  compiled_query text not null,
  -- Recency window applied per poll. Google's date attribution is unreliable,
  -- so dedupe (not the filter) is the real guarantee against repeats.
  recency text not null default 'week' check (recency in ('day','week','month','any')),
  -- Free = daily; paid = hourly. Enforced in the cron/actions layer.
  frequency text not null default 'daily' check (frequency in ('daily','hourly')),
  status text not null default 'active' check (status in ('active','paused')),
  -- Backlink-discovery category: crawl each candidate and confirm an anchor
  -- to backlink_domain exists in the HTML before alerting.
  confirm_backlink boolean not null default false,
  backlink_domain text,
  -- Cold-start: false until the first poll has seeded the seen-set silently.
  seeded boolean not null default false,
  last_checked_at timestamptz,
  next_run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists alerts_owner_idx
  on public.alerts(owner_id, created_at desc);
-- The cron sweep selects active alerts whose next_run_at has passed.
create index if not exists alerts_due_idx
  on public.alerts(next_run_at) where status = 'active';

alter table public.alerts enable row level security;

create policy "alerts owner select"
  on public.alerts for select
  using (auth.uid() = owner_id);

-- Writes flow through server actions on the service client (after an
-- auth.getUser() check), mirroring the rest of the app; no user-facing
-- INSERT/UPDATE/DELETE policies needed.

-- ============================================================
-- alert_seen_urls — per-alert dedupe set, keyed on canonical URL.
-- Retained even when an alert is paused (pausing must not resurface old URLs).
-- ============================================================
create table if not exists public.alert_seen_urls (
  alert_id uuid not null references public.alerts(id) on delete cascade,
  canonical_url text not null,
  first_seen_at timestamptz not null default now(),
  primary key (alert_id, canonical_url)
);

alter table public.alert_seen_urls enable row level security;
-- Service-role only (no policies): the dedupe set is never read by the browser.

-- ============================================================
-- alert_findings — a never-seen-before result. emailed_at NULL = pending.
-- ============================================================
create table if not exists public.alert_findings (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.alerts(id) on delete cascade,
  -- Denormalized for the per-user batched-digest query and for RLS.
  owner_id uuid not null references public.profiles(id) on delete cascade,
  url text not null,
  canonical_url text not null,
  title text,
  snippet text,
  position int,
  category text,
  confirmed_backlink boolean not null default false,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists alert_findings_owner_pending_idx
  on public.alert_findings(owner_id) where emailed_at is null;
create index if not exists alert_findings_alert_idx
  on public.alert_findings(alert_id, created_at desc);

alter table public.alert_findings enable row level security;

create policy "alert_findings owner select"
  on public.alert_findings for select
  using (auth.uid() = owner_id);

-- ============================================================
-- consume_alert_serp_budget: atomically reserve p_count SERP calls for an
-- owner if it keeps them at/under p_cap for the current 30-day window.
-- Rolls the window over lazily on first call after reset. Returns true if
-- the calls were reserved. Mirrors consume_credit's optimistic-update shape.
-- ============================================================
create or replace function public.consume_alert_serp_budget(
  p_owner uuid,
  p_count int,
  p_cap int
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_used int;
begin
  -- Lazy monthly reset.
  update public.profiles
  set alert_serp_calls_used = 0,
      alert_serp_calls_reset_at = now() + interval '30 days'
  where id = p_owner and alert_serp_calls_reset_at <= now();

  update public.profiles
  set alert_serp_calls_used = alert_serp_calls_used + p_count
  where id = p_owner and alert_serp_calls_used + p_count <= p_cap
  returning alert_serp_calls_used into v_used;

  return v_used is not null;
end;
$$;

grant execute on function public.consume_alert_serp_budget(uuid, int, int)
  to authenticated, service_role;

-- ============================================================
-- updated_at trigger for alerts.
-- ============================================================
create or replace function public.alerts_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists alerts_set_updated_at on public.alerts;
create trigger alerts_set_updated_at
  before update on public.alerts
  for each row execute function public.alerts_touch_updated_at();

-- ============================================================
-- pg_cron: sweep due alerts every 10 minutes. The endpoint honors each
-- alert's own next_run_at (daily vs hourly), so a frequent tick just keeps
-- latency low without over-polling. Global kill-switch: set cron_config
-- key 'alerts_enabled' to 'false' to halt all ValueSERP spend at once.
-- ============================================================
do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-alert-checks') then
    perform cron.unschedule('crawlproof-alert-checks');
  end if;
end $$;

select cron.schedule(
  'crawlproof-alert-checks',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select value from public.cron_config where key = 'site_url') || '/api/cron/alert-checks',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.cron_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
