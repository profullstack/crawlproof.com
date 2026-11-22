-- A/B test stats for any product (not ads: ad creative tests live in ad_experiments).
--
-- A product (board.saas, a fleet site, a newsletter) owns experiments through a
-- crp_ API token. Units (an account, a visitor) get one sticky arm per experiment,
-- picked deterministically from (experiment key, unit) by @profullstack/abtest, so
-- a client that cannot reach us computes the same arm. Events are exposure (saw the
-- treatment: the conversion denominator), conversion, revenue (value = amount) and
-- named engagement events. Unit ids are stored as sha256(experiment id || unit) so
-- a product's account ids never sit here in the clear.
--
-- Only the service role reads or writes these tables (RLS on, no policies): the
-- API routes and the dashboard check ownership before every query.

create table if not exists public.ab_experiments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  name text not null,
  description text,
  arms jsonb not null,
  control text not null,
  min_per_arm integer not null default 100 check (min_per_arm between 1 and 1000000),
  status text not null default 'running' check (status in ('running', 'paused', 'stopped')),
  winner text,
  created_at timestamptz not null default now(),
  stopped_at timestamptz,
  unique (owner_id, key)
);

create table if not exists public.ab_assignments (
  experiment_id uuid not null references public.ab_experiments(id) on delete cascade,
  unit_hash text not null,
  arm text not null,
  offline boolean not null default false,
  assigned_at timestamptz not null default now(),
  primary key (experiment_id, unit_hash)
);
create index if not exists ab_assignments_arm on public.ab_assignments (experiment_id, arm);

create table if not exists public.ab_events (
  id bigserial primary key,
  experiment_id uuid not null references public.ab_experiments(id) on delete cascade,
  unit_hash text not null,
  arm text not null,
  type text not null check (type in ('exposure', 'conversion', 'revenue', 'event')),
  name text,
  value numeric,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create index if not exists ab_events_experiment on public.ab_events (experiment_id, arm, type);
create unique index if not exists ab_events_dedupe on public.ab_events (experiment_id, dedupe_key) where dedupe_key is not null;

alter table public.ab_experiments enable row level security;
alter table public.ab_assignments enable row level security;
alter table public.ab_events enable row level security;
revoke all on public.ab_experiments, public.ab_assignments, public.ab_events from anon, authenticated;

-- Per-arm counts in one round trip (PostgREST caps a plain select at 1,000 rows).
-- conversions count exposed units only: a unit that converts without an exposure
-- event is not in the denominator, so it must not be in the numerator either.
create or replace function public.ab_arm_counts(p_experiment uuid)
returns table (
  arm text,
  assigned bigint,
  exposed bigint,
  converted bigint,
  revenue numeric,
  events jsonb
)
language sql
stable
set search_path = public
as $$
  with arms as (
    select a.arm, count(*) as assigned
    from ab_assignments a where a.experiment_id = p_experiment group by a.arm
  ),
  exposed as (
    select distinct e.arm, e.unit_hash from ab_events e
    where e.experiment_id = p_experiment and e.type = 'exposure'
  ),
  conv as (
    select distinct e.arm, e.unit_hash from ab_events e
    join exposed x on x.unit_hash = e.unit_hash and x.arm = e.arm
    where e.experiment_id = p_experiment and e.type = 'conversion'
  ),
  rev as (
    select e.arm, sum(coalesce(e.value, 0)) as revenue from ab_events e
    where e.experiment_id = p_experiment and e.type = 'revenue' group by e.arm
  ),
  named as (
    select e.arm, e.name, count(distinct e.unit_hash) as units, count(*) as n from ab_events e
    where e.experiment_id = p_experiment and e.type = 'event' and e.name is not null
    group by e.arm, e.name
  ),
  all_arms as (
    select arm from arms union select arm from exposed union select arm from rev union select arm from named
  )
  select
    aa.arm,
    coalesce((select assigned from arms where arms.arm = aa.arm), 0),
    (select count(*) from exposed where exposed.arm = aa.arm),
    (select count(*) from conv where conv.arm = aa.arm),
    coalesce((select revenue from rev where rev.arm = aa.arm), 0),
    coalesce((select jsonb_object_agg(name, jsonb_build_object('units', units, 'count', n)) from named where named.arm = aa.arm), '{}'::jsonb)
  from all_arms aa;
$$;

revoke all on function public.ab_arm_counts(uuid) from public, anon, authenticated;
grant execute on function public.ab_arm_counts(uuid) to service_role;
