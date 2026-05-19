-- Add seed × modifier cross-build inputs.
--
-- modifiers: short tail terms ("payments", "merchant account",
-- "payment gateway") that get crossed with seed_keywords to produce
-- the long-tail target list locally — no DataForSEO call needed.
--
-- preserve_keywords: when true, Refetch flows (sitemap detect +
-- Anthropic enrichment + DFS expansion) must NOT overwrite the
-- existing `keywords` text[]. Lets the user hand-curate the list and
-- still re-run discovery for niche/description without losing it.

alter table public.lx_site
  add column if not exists modifiers text[] not null default '{}';

alter table public.lx_site
  add column if not exists preserve_keywords boolean not null default false;

comment on column public.lx_site.modifiers is
  'Tail terms (e.g. "payments", "merchant account") that are crossed with seed_keywords to build the long-tail keyword list locally.';

comment on column public.lx_site.preserve_keywords is
  'When true, Refetch flows skip overwriting the `keywords` column. Used after a hand-curated build via seeds × modifiers.';
