-- Broad head-term seeds for DataForSEO long-tail expansion.
-- Distinct from `keywords` (the long-tail targets the AI writer aims
-- at): seed_keywords are 1-3 word head terms ("web security",
-- "cyber security") that DFS expands into related long-tail phrases
-- with monthly search volumes.

alter table public.lx_site
  add column if not exists seed_keywords text[] not null default '{}';
