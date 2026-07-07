-- Ad network — Phase 1: advertiser campaigns + auto-generated creatives.
--
-- An advertiser (existing crawlproof user) gives a destination URL + a daily
-- budget; we extract the destination's brand and generate on-brand creatives
-- they can preview, edit, or replace with their own uploaded assets. Serving,
-- publisher slots, and payouts are later phases (see docs/ad-network-prd.md).
--
-- NOTE: prod migration history diverged — apply this single file via psql over
-- the pooler (see the crawlproof-alerts memory), do NOT `supabase db push`.

-- Human-readable campaign refs: crawlproof-ad-001, -002, … appended to the
-- destination URL as ?ref= so advertisers can attribute traffic.
create sequence if not exists public.ad_campaign_seq;

create table if not exists public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  seq bigint not null default nextval('public.ad_campaign_seq'),
  ref_slug text generated always as ('crawlproof-ad-' || lpad(seq::text, 3, '0')) stored,
  name text not null,
  destination_url text not null,
  destination_domain text,
  daily_budget_cents integer not null default 500 check (daily_budget_cents >= 0),
  status text not null default 'draft'
    check (status in ('draft','pending_review','active','paused','exhausted','rejected')),
  brand jsonb not null default '{}'::jsonb,      -- extracted logo/palette/title/desc
  targeting jsonb not null default '{}'::jsonb,   -- niches[]/geos[]/device[] (later phases)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ad_campaigns_ref_slug_key on public.ad_campaigns(ref_slug);
create index if not exists ad_campaigns_owner_idx on public.ad_campaigns(owner_id);

create table if not exists public.ad_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  format text not null
    check (format in ('banner_300x250','banner_728x90','banner_320x50')),
  headline text not null default '',
  body text not null default '',
  cta_text text not null default 'Learn more',
  image_url text,                 -- optional hero/product image (generated or uploaded)
  logo_url text,                  -- destination brand logo
  bg_color text not null default '#0b0d10',
  fg_color text not null default '#e7e9ee',
  accent_color text not null default '#6ee7b7',
  font_family text not null default 'system-ui, sans-serif',
  ai_provenance jsonb not null default '{}'::jsonb,  -- provider + model, for regen/audit
  status text not null default 'ready'
    check (status in ('generating','ready','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists ad_creatives_campaign_idx on public.ad_creatives(campaign_id);

-- keep updated_at fresh on campaign edits
create or replace function public.ad_campaigns_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ad_campaigns_touch on public.ad_campaigns;
create trigger ad_campaigns_touch before update on public.ad_campaigns
  for each row execute function public.ad_campaigns_touch();

-- RLS: owners see/manage only their own campaigns + creatives.
alter table public.ad_campaigns enable row level security;
alter table public.ad_creatives enable row level security;

drop policy if exists "own campaigns" on public.ad_campaigns;
create policy "own campaigns" on public.ad_campaigns
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "own creatives" on public.ad_creatives;
create policy "own creatives" on public.ad_creatives
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Public bucket for advertiser-uploaded creative assets.
insert into storage.buckets (id, name, public)
values ('ad-assets', 'ad-assets', true)
on conflict (id) do nothing;
