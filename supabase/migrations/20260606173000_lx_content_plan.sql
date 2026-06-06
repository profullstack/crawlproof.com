-- Content-plan metadata for Autopilot Phase 2.
--
-- lx_keyword already has scheduled_for, search_volume, difficulty, and
-- source. These columns add the per-topic planning and instruction fields
-- needed for the 30-day planner UI.

alter table public.lx_keyword
  add column if not exists article_type text,
  add column if not exists article_subtype text,
  add column if not exists custom_instructions text,
  add column if not exists status_reason text,
  add column if not exists source_context jsonb not null default '{}'::jsonb;

create table if not exists public.lx_keyword_asset (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid not null references public.lx_keyword(id) on delete cascade,
  storage_path text not null,
  alt_text text,
  created_at timestamptz not null default now()
);

create index if not exists lx_keyword_asset_keyword_idx
  on public.lx_keyword_asset(keyword_id, created_at desc);

alter table public.lx_keyword_asset enable row level security;

create policy "lx_keyword_asset via owned keyword"
  on public.lx_keyword_asset for select
  using (
    exists (
      select 1
      from public.lx_keyword k
      join public.lx_site s on s.id = k.site_id
      where k.id = keyword_id
        and public.is_project_member(s.project_id, (select auth.uid()))
    )
  );

