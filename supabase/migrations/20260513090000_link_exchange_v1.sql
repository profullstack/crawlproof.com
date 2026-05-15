-- Link Exchange — autoblogging v1.
-- This migration covers the autoblogging + webhook half of the PRD
-- (docs/link-exchange-prd.md §3, §6, §7). The backlink-exchange tables
-- (lx_backlink, lx_credit_ledger) are intentionally deferred until the
-- network has enough participants for the exchange to be useful.
--
-- Forward-compatibility: lx_site keeps the backlinks_enabled +
-- external_links_per_article fields so the exchange can be turned on
-- per-site later without another schema change.

create extension if not exists vector;

-- ============================================================
-- lx_site — one row per enrolled domain (1 per user in v1)
-- ============================================================
create table if not exists public.lx_site (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null,
  url text not null,
  blog_root_url text not null,
  sitemap_url text not null,
  niche text,
  target_audiences text[] not null default '{}',
  description text not null default '',
  status text not null default 'active'
    check (status in ('active','paused','flagged')),
  -- Exchange knobs — present but disabled in v1.
  backlinks_enabled boolean not null default false,
  external_links_per_article smallint not null default 0,
  internal_links_per_article smallint not null default 3,
  daily_article_count smallint not null default 1,
  publish_days smallint[] not null default '{1,2,3,4,5}',
  publish_hour smallint not null default 9
    check (publish_hour between 0 and 23),
  next_publish_at timestamptz,
  webhook_url text,
  -- Bearer token sent in Authorization header. Plaintext at rest;
  -- rotated via POST /api/lx/site/regenerate-secret.
  webhook_secret text,
  credit_balance integer not null default 0,
  embedding vector(1536),
  last_sitemap_fetch_at timestamptz,
  sitemap_status text,
  inappropriate_content boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- v1: one site per user. Drop this unique index to enable multi-site later.
create unique index if not exists lx_site_user_unique on public.lx_site(user_id);
create unique index if not exists lx_site_domain_unique on public.lx_site(lower(domain));
create index if not exists lx_site_next_publish_idx
  on public.lx_site(next_publish_at)
  where status = 'active';

alter table public.lx_site enable row level security;

create policy "lx_site owner all"
  on public.lx_site for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- lx_site_page — pages discovered from the sitemap.
-- Internal-link target pool (and, later, exchange target pool).
-- ============================================================
create table if not exists public.lx_site_page (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.lx_site(id) on delete cascade,
  url text not null,
  title text,
  description text,
  embedding vector(1536),
  is_blog_post boolean not null default false,
  last_seen_at timestamptz not null default now()
);

create unique index if not exists lx_site_page_unique on public.lx_site_page(site_id, url);
create index if not exists lx_site_page_blog_idx on public.lx_site_page(site_id, is_blog_post);

alter table public.lx_site_page enable row level security;

create policy "lx_site_page via owned site"
  on public.lx_site_page for select
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = site_id and s.user_id = auth.uid()
    )
  );

-- ============================================================
-- lx_keyword — editorial calendar
-- ============================================================
create table if not exists public.lx_keyword (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.lx_site(id) on delete cascade,
  keyword text not null,
  scheduled_for date not null,
  status text not null default 'queued'
    check (status in ('queued','generating','published','failed','skipped')),
  source text not null default 'auto'
    check (source in ('manual','auto')),
  -- Optional metrics cached from DataForSEO at scheduling time.
  search_volume integer,
  difficulty smallint,
  cpc_usd numeric(10,2),
  article_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists lx_keyword_schedule_idx
  on public.lx_keyword(site_id, scheduled_for);
create index if not exists lx_keyword_status_idx
  on public.lx_keyword(site_id, status);

alter table public.lx_keyword enable row level security;

create policy "lx_keyword via owned site"
  on public.lx_keyword for select
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = site_id and s.user_id = auth.uid()
    )
  );

-- ============================================================
-- lx_article — generated posts
-- ============================================================
create table if not exists public.lx_article (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.lx_site(id) on delete cascade,
  keyword_id uuid references public.lx_keyword(id) on delete set null,
  title text not null,
  slug text not null,
  meta_description text not null,
  content_markdown text not null,
  content_html text not null,
  image_url text,
  tags text[] not null default '{}',
  -- Outbound links inserted by the exchange matcher. Empty array in v1.
  -- Shape: [{ "url": "...", "anchor": "..." }, ...]
  outbound_links jsonb not null default '[]'::jsonb,
  internal_links jsonb not null default '[]'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','generating','ready','publishing','published','failed')),
  published_at timestamptz,
  webhook_delivery_id uuid,
  webhook_response_code int,
  webhook_last_error text,
  webhook_attempts smallint not null default 0,
  generation_error text,
  created_at timestamptz not null default now()
);

create index if not exists lx_article_site_published_idx
  on public.lx_article(site_id, published_at desc nulls last);
create index if not exists lx_article_status_idx
  on public.lx_article(site_id, status);
create unique index if not exists lx_article_slug_unique
  on public.lx_article(site_id, slug);

-- Backref now that lx_article exists.
alter table public.lx_keyword
  drop constraint if exists lx_keyword_article_id_fkey;
alter table public.lx_keyword
  add constraint lx_keyword_article_id_fkey
  foreign key (article_id) references public.lx_article(id) on delete set null;

alter table public.lx_article enable row level security;

create policy "lx_article via owned site"
  on public.lx_article for select
  using (
    exists (
      select 1 from public.lx_site s
      where s.id = site_id and s.user_id = auth.uid()
    )
  );

-- ============================================================
-- lx_keyword_metrics — DataForSEO cache (PRD §15.3)
-- Cross-tenant: same keyword/region is shared across all customers.
-- ============================================================
create table if not exists public.lx_keyword_metrics (
  id bigserial primary key,
  keyword text not null,
  region text not null default 'us',
  search_volume integer,
  difficulty smallint,
  cpc_usd numeric(10,2),
  competition text,
  competition_index smallint,
  low_top_of_page_bid numeric(10,2),
  high_top_of_page_bid numeric(10,2),
  monthly_searches jsonb,
  source text not null default 'dataforseo',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 days'
);

create unique index if not exists lx_keyword_metrics_unique
  on public.lx_keyword_metrics(lower(keyword), region);
create index if not exists lx_keyword_metrics_expires_idx
  on public.lx_keyword_metrics(expires_at);

-- Read-only to clients via service role (no RLS policies = deny everything
-- to anon/authenticated when RLS is on).
alter table public.lx_keyword_metrics enable row level security;

-- ============================================================
-- lx_dataforseo_usage — append-only spend ledger (PRD §15.2b)
-- ============================================================
create table if not exists public.lx_dataforseo_usage (
  id bigserial primary key,
  task_id text,
  endpoint text not null,
  cost numeric(10,4) not null default 0,
  site_id uuid references public.lx_site(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists lx_dataforseo_usage_created_idx
  on public.lx_dataforseo_usage(created_at desc);

alter table public.lx_dataforseo_usage enable row level security;

-- ============================================================
-- updated_at maintenance for lx_site (the only table users mutate often)
-- ============================================================
create or replace function public.lx_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists lx_site_set_updated_at on public.lx_site;
create trigger lx_site_set_updated_at
  before update on public.lx_site
  for each row execute function public.lx_set_updated_at();
