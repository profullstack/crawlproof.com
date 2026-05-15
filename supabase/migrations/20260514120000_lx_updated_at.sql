-- Add updated_at to lx_article and lx_keyword so the worker sweep can
-- detect rows stuck in non-terminal states (publishing / generating)
-- without false positives from created_at-based heuristics.
--
-- Reuses public.lx_set_updated_at() from the v1 migration.

alter table public.lx_article
  add column if not exists updated_at timestamptz not null default now();

alter table public.lx_keyword
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists lx_article_set_updated_at on public.lx_article;
create trigger lx_article_set_updated_at
  before update on public.lx_article
  for each row execute function public.lx_set_updated_at();

drop trigger if exists lx_keyword_set_updated_at on public.lx_keyword;
create trigger lx_keyword_set_updated_at
  before update on public.lx_keyword
  for each row execute function public.lx_set_updated_at();
