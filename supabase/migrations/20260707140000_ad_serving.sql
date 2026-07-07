-- Ad network — Phase 2: publisher slots + impression/click metering.
--
-- A publisher opts one of their projects in as an ad slot and drops the
-- /ad.js tag on their site. Serving picks an active campaign's matching
-- creative, records an impression, and click-throughs redirect via
-- /api/ads/click (which appends ?ref=). Money movement (budget debit +
-- publisher accrual/payout) is a later phase — see docs/ad-network-prd.md.
--
-- Apply via psql over the pooler (prod history diverged), not `db push`.

create table if not exists public.ad_slots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  formats text[] not null default array['banner_300x250','banner_728x90','banner_320x50'],
  placement text not null default 'inline'
    check (placement in ('inline','sidebar','footer','sticky')),
  niche text,
  min_cpc_cents integer not null default 0 check (min_cpc_cents >= 0),
  allow_categories text[] not null default '{}',
  deny_categories text[] not null default '{}',
  payout_address text,
  payout_currency text,
  status text not null default 'inactive'
    check (status in ('inactive','pending_review','active','paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ad_slots_owner_idx on public.ad_slots(owner_id);
create index if not exists ad_slots_project_idx on public.ad_slots(project_id);

-- Append-only metering. Written by the public serving endpoints via the
-- service-role client, so no public RLS insert policy is needed.
create table if not exists public.ad_impressions (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.ad_slots(id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  creative_id uuid not null references public.ad_creatives(id) on delete cascade,
  visitor_id text,
  ip_hash text,
  geo_country text,
  device text,
  billable boolean not null default false,
  ts timestamptz not null default now()
);
create index if not exists ad_impressions_slot_ts_idx on public.ad_impressions(slot_id, ts);
create index if not exists ad_impressions_campaign_ts_idx on public.ad_impressions(campaign_id, ts);

create table if not exists public.ad_clicks (
  id uuid primary key default gen_random_uuid(),
  impression_id uuid references public.ad_impressions(id) on delete set null,
  slot_id uuid not null references public.ad_slots(id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  creative_id uuid not null references public.ad_creatives(id) on delete cascade,
  visitor_id text,
  ip_hash text,
  geo_country text,
  device text,
  charged_cents integer not null default 0,
  publisher_earn_cents integer not null default 0,
  platform_cut_cents integer not null default 0,
  valid boolean not null default true,
  ts timestamptz not null default now()
);
create index if not exists ad_clicks_slot_ts_idx on public.ad_clicks(slot_id, ts);
create index if not exists ad_clicks_campaign_ts_idx on public.ad_clicks(campaign_id, ts);

drop trigger if exists ad_slots_touch on public.ad_slots;
create trigger ad_slots_touch before update on public.ad_slots
  for each row execute function public.ad_campaigns_touch();

-- RLS: owners manage their own slots. Impressions/clicks are readable by the
-- owner of the referenced slot (for reporting); inserts go through service role.
alter table public.ad_slots enable row level security;
alter table public.ad_impressions enable row level security;
alter table public.ad_clicks enable row level security;

drop policy if exists "own slots" on public.ad_slots;
create policy "own slots" on public.ad_slots
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "read own slot impressions" on public.ad_impressions;
create policy "read own slot impressions" on public.ad_impressions
  for select using (
    exists (select 1 from public.ad_slots s where s.id = slot_id and s.owner_id = auth.uid())
    or exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.owner_id = auth.uid())
  );

drop policy if exists "read own slot clicks" on public.ad_clicks;
create policy "read own slot clicks" on public.ad_clicks
  for select using (
    exists (select 1 from public.ad_slots s where s.id = slot_id and s.owner_id = auth.uid())
    or exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.owner_id = auth.uid())
  );
