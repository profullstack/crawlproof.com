-- 30-day validation test (prd/validation-30d.md): funnel tracking, paid
-- weekly monitoring, batch audits and public rankings.
--
-- Apply by hand, one file, like every crawlproof migration. Idempotent.

-- ============================================================
-- Audit provenance: where the visit that produced it came from, and the
-- batch run that created it (null = somebody ran it themselves).
-- ============================================================
alter table public.audits
  add column if not exists funnel_source text not null default 'organic';
alter table public.audits drop constraint if exists audits_funnel_source_check;
alter table public.audits add constraint audits_funnel_source_check
  check (funnel_source in ('organic', 'outreach', 'ranking'));
alter table public.audits add column if not exists batch_id uuid;
create index if not exists audits_batch_id_idx on public.audits (batch_id) where batch_id is not null;

-- ============================================================
-- R6: funnel events. Service-role only; one row per event.
-- ============================================================
create table if not exists public.funnel_events (
  id bigserial primary key,
  event text not null check (event in (
    'audit_started', 'audit_completed', 'report_viewed',
    'signup', 'checkout_started', 'subscribed'
  )),
  source text not null default 'organic' check (source in ('organic', 'outreach', 'ranking')),
  visitor_id text,
  audit_id uuid,
  user_id uuid,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists funnel_events_created_idx on public.funnel_events (created_at);
create index if not exists funnel_events_event_idx on public.funnel_events (event, created_at);
create index if not exists funnel_events_audit_idx on public.funnel_events (audit_id) where audit_id is not null;
alter table public.funnel_events enable row level security;

-- audit_completed is recorded by the database, not the worker, so it can
-- never be missed by a code path that finishes an audit. Only audits a
-- person ran themselves count (manual, not a batch); the visitor and source
-- are carried over from that audit's audit_started event.
create or replace function public.funnel_audit_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'complete'
     and old.status is distinct from 'complete'
     and new.triggered_by = 'manual'
     and new.batch_id is null
     and new.project_id is null then
    insert into public.funnel_events (event, source, visitor_id, audit_id, user_id, meta)
    select 'audit_completed', new.funnel_source,
           (select visitor_id from public.funnel_events
             where audit_id = new.id and event = 'audit_started'
             order by id limit 1),
           new.id, new.owner_id,
           jsonb_build_object('engine', new.engine, 'score', new.score);
  end if;
  return new;
end $$;

drop trigger if exists audits_funnel_completed on public.audits;
create trigger audits_funnel_completed
  after update of status on public.audits
  for each row execute function public.funnel_audit_completed();

-- The one query: weekly counts by source. `people` is distinct visitors (or
-- users when there is no visitor id).
create or replace view public.funnel_weekly as
select date_trunc('week', created_at)::date as week,
       source,
       event,
       count(*) as events,
       count(distinct coalesce(visitor_id, user_id::text, audit_id::text)) as people
from public.funnel_events
group by 1, 2, 3;

revoke all on public.funnel_weekly from anon, authenticated;

-- ============================================================
-- R3: paid weekly monitoring. CoinPay has no card-on-file, so a period is
-- bought with a one-off checkout session (any coin or PayPal) and renewed by
-- the same link, emailed before it runs out.
-- ============================================================
create table if not exists public.monitor_subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  plan text not null check (plan in ('solo', 'agency')),
  site_limit int not null,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'canceled', 'expired')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  funnel_source text not null default 'organic'
    check (funnel_source in ('organic', 'outreach', 'ranking')),
  origin_audit_id uuid references public.audits(id) on delete set null,
  renewal_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists monitor_subscriptions_owner_idx on public.monitor_subscriptions (owner_id);
create index if not exists monitor_subscriptions_period_idx
  on public.monitor_subscriptions (current_period_end) where status = 'active';
alter table public.monitor_subscriptions enable row level security;

drop trigger if exists monitor_subscriptions_set_updated_at on public.monitor_subscriptions;
create trigger monitor_subscriptions_set_updated_at
  before update on public.monitor_subscriptions
  for each row execute function public.lx_set_updated_at();

create table if not exists public.monitor_payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.monitor_subscriptions(id) on delete cascade,
  coinpay_session_id text unique,
  amount_cents int not null,
  status text not null default 'pending' check (status in ('pending', 'complete', 'failed')),
  period_end timestamptz,
  completed_at timestamptz,
  event jsonb,
  created_at timestamptz not null default now()
);
create index if not exists monitor_payments_sub_idx on public.monitor_payments (subscription_id);
alter table public.monitor_payments enable row level security;

-- A paid watch belongs to its subscription: it is pre-verified (paying is the
-- opt-in) and stops when the subscription does.
alter table public.scan_watches
  add column if not exists subscription_id uuid references public.monitor_subscriptions(id) on delete set null;
create index if not exists scan_watches_subscription_idx
  on public.scan_watches (subscription_id) where subscription_id is not null;

-- ============================================================
-- R5: public rankings. A ranking is a published batch.
-- ============================================================
create table if not exists public.rankings (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  title text not null,
  list_name text not null,
  method text not null,
  batch_id uuid not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.rankings enable row level security;
