-- CrawlProof <-> PostHog bidirectional integration, V1 internal-first.

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  provider text not null,
  direction text not null check (direction in ('outbound', 'inbound', 'bidirectional')),
  name text not null,
  status text not null default 'disabled'
    check (status in ('enabled', 'disabled', 'error')),
  config jsonb not null default '{}',
  encrypted_credentials jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider, name)
);

create index if not exists integrations_org_provider_idx
  on public.integrations(org_id, provider, status);

create index if not exists integrations_provider_status_idx
  on public.integrations(provider, status)
  where org_id is null;

create trigger integrations_set_updated_at
  before update on public.integrations
  for each row execute function public.lx_set_updated_at();

alter table public.integrations enable row level security;

create policy "integrations org member select"
  on public.integrations for select
  using (
    org_id is not null
    and (select public.is_org_member(org_id, auth.uid()))
  );

create policy "integrations org owner write"
  on public.integrations for all
  using (
    org_id is not null
    and (select public.is_org_owner(org_id, auth.uid()))
  )
  with check (
    org_id is not null
    and (select public.is_org_owner(org_id, auth.uid()))
  );

create table if not exists public.event_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  provider text not null,
  destination text not null,
  event_name text not null,
  category text not null default 'product',
  payload jsonb not null,
  idempotency_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'delivering', 'delivered', 'failed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, destination, idempotency_key)
);

create index if not exists event_outbox_due_idx
  on public.event_outbox(next_attempt_at, created_at)
  where status in ('pending', 'failed');

create index if not exists event_outbox_org_created_idx
  on public.event_outbox(org_id, created_at desc);

create index if not exists event_outbox_provider_status_idx
  on public.event_outbox(provider, status, created_at desc);

create trigger event_outbox_set_updated_at
  before update on public.event_outbox
  for each row execute function public.lx_set_updated_at();

alter table public.event_outbox enable row level security;

create policy "event_outbox org member select"
  on public.event_outbox for select
  using (
    org_id is not null
    and (select public.is_org_member(org_id, auth.uid()))
  );

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  provider text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  event_name text,
  action text,
  idempotency_key text,
  request_headers jsonb not null default '{}',
  request_payload jsonb not null default '{}',
  response_status integer,
  response_payload jsonb,
  status text not null
    check (status in ('accepted', 'duplicate', 'rejected', 'failed', 'delivered')),
  error text,
  created_at timestamptz not null default now()
);

create unique index if not exists webhook_events_provider_idempotency_unique
  on public.webhook_events(provider, idempotency_key)
  where idempotency_key is not null;

create index if not exists webhook_events_org_created_idx
  on public.webhook_events(org_id, created_at desc);

create index if not exists webhook_events_provider_direction_created_idx
  on public.webhook_events(provider, direction, created_at desc);

alter table public.webhook_events enable row level security;

create policy "webhook_events org member select"
  on public.webhook_events for select
  using (
    org_id is not null
    and (select public.is_org_member(org_id, auth.uid()))
  );
